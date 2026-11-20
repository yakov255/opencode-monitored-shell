// monitored-shell — все команды запускаются в фоне, вывод целиком пишется в файл.
//
// Почему не встроенный shell: он держит вывод в памяти инструмента, режет его
// (в контекст попадает только хвост), а долгая команда умирает по таймауту
// вместе с ходом. Здесь процесс живёт отдельно от сессии, полный лог всегда
// на диске, а агент забирает только новые строки.
//
// OpenCode 2 (V2 plugin API): default export { id, setup(ctx) }.
//
// Инструменты:
//   run          запустить команду в фоне, вернуть id/pid/путь лога
//   run_status   статус; wait=N — подождать до N секунд и отдать только НОВЫЕ строки
//   run_logs     прочитать лог: tail / grep / offset / from_line
//   run_stop     SIGTERM, затем SIGKILL по таймауту
//   run_list     список прогонов
//   run_cleanup  удалить завершённые прогоны старше N часов
//
// Автоматической остановки по содержимому лога нет намеренно: `error:` печатают
// и успешные сборки. run_status отдаёт поле `warnings` — материал для решения,
// а не приговор.

import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// --- состояние на диске ----------------------------------------------------
//
// Реестр и логи лежат вне проектов: не мусорят в git и не требуют прав на
// запись в чужой каталог. Прогон переживает перезапуск сервиса OpenCode.

const RUNS_DIR = join(
  process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
  'opencode',
  'runs',
)
const INDEX = join(RUNS_DIR, 'runs.json')

// Строки, которые стоит показать как «похоже на ошибку». Не приговор:
// ровно поэтому поле называется warnings, а не errors.
const WARN_RE = /(\berror\b|\bfatal\b|\bpanic\b|\btraceback\b|\bfailed\b|\bcannot\b|\bdenied\b)/i

// Сколько держим завершённые прогоны, если не сказано иное.
const DEFAULT_RETENTION_HOURS = 72

function ensureDir() {
  mkdirSync(RUNS_DIR, { recursive: true })
}

function loadIndex() {
  ensureDir()
  try {
    const raw = readFileSync(INDEX, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveIndex(index) {
  ensureDir()
  // Атомарная запись: реестр читают несколько прогонов параллельно.
  const tmp = `${INDEX}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(index, null, 2))
  renameSync(tmp, INDEX)
}

function updateRun(id, patch) {
  const index = loadIndex()
  if (!index[id]) return
  index[id] = { ...index[id], ...patch }
  saveIndex(index)
}

function newId(command, label) {
  const raw = label || (command.trim().split(/\s+/)[0] || 'run').split('/').pop()
  const slug = String(raw).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24) || 'run'
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${slug}-${ts}-${rand}`
}

function logPath(id) {
  return join(RUNS_DIR, `${id}.log`)
}

// --- процесс ---------------------------------------------------------------

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// Статус с учётом того, что процесс мог умереть, пока плагин не работал.
function statusOf(run) {
  if (run.exitCode !== null && run.exitCode !== undefined) return 'exited'
  if (!isAlive(run.pid)) return 'lost'
  return 'running'
}

function readLog(id, { offset = 0, maxBytes = 256 * 1024 } = {}) {
  const path = logPath(id)
  if (!existsSync(path)) return { text: '', size: 0, next: offset }
  const size = statSync(path).size
  if (offset >= size) return { text: '', size, next: offset }
  const length = Math.min(size - offset, maxBytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, length, offset)
  } finally {
    closeSync(fd)
  }
  let text = buffer.toString('utf8')
  let consumed = length

  // Граница чанка может разрезать строку: тогда первая её половина ушла бы
  // в эту дельту, а вторая — в следующую, как отдельная строка. Отступаем
  // до последнего перевода строки, чтобы строки никогда не рвались.
  if (offset + length < size) {
    const cut = text.lastIndexOf('\n')
    if (cut >= 0) {
      text = text.slice(0, cut + 1)
      consumed = Buffer.byteLength(text, 'utf8')
    }
  }

  return { text, size, next: offset + consumed }
}

function tailLog(id, lines) {
  const path = logPath(id)
  if (!existsSync(path)) return ''
  const text = readFileSync(path, 'utf8')
  if (!lines || lines <= 0) return text
  const parts = text.split('\n')
  return parts.slice(-lines).join('\n')
}

function sortLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim()) out.push(line)
  }
  return out
}

function findWarnings(text, limit = 8) {
  const hits = []
  for (const line of sortLines(text)) {
    if (WARN_RE.test(line)) {
      hits.push(line.length > 400 ? `${line.slice(0, 400)}…` : line)
      if (hits.length >= limit) break
    }
  }
  return hits
}

// --- запуск ----------------------------------------------------------------

function startRun({ command, cwd, label, onFinish }) {
  ensureDir()
  const id = newId(command, label)
  const path = logPath(id)
  const fd = openSync(path, 'a')

  // detached: своя process group, поэтому прогон не умирает вместе с ходом
  // агента и его можно погасить целиком (-pid).
  const child = spawn(command, {
    cwd: cwd || undefined,
    shell: true,
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  closeSync(fd)

  const index = loadIndex()
  index[id] = {
    id,
    label: label || null,
    command,
    cwd: cwd || process.cwd(),
    pid: child.pid,
    startedAt: new Date().toISOString(),
    exitCode: null,
    endedAt: null,
    log: path,
  }
  saveIndex(index)

  // Вариант B: одна нотификация на завершение. Процесс может закончиться,
  // когда агент занят другим, поэтому кроме записи в реестр шлём себе
  // synthetic-сообщение в сессию, которая его запустила.
  const record = (exitCode) => {
    updateRun(id, { exitCode, endedAt: new Date().toISOString() })
    onFinish?.({ id, exitCode, label: label || null, command })
  }

  child.once('exit', (code, signal) => {
    record(code === null ? (signal ? `signal:${signal}` : 'unknown') : code)
  })
  child.once('error', (error) => record(`error:${error.message}`))

  return { id, pid: child.pid, log: path }
}

// Ожидание: возвращаемся сразу, если процесс завершился, иначе спим не больше
// wait секунд. Нужно, чтобы «смотреть раз в 30 секунд» стоило один вызов.
async function waitFor(id, seconds, pollMs = 500) {
  const deadline = Date.now() + Math.max(0, seconds) * 1000
  while (Date.now() < deadline) {
    const run = loadIndex()[id]
    if (!run) return null
    if (statusOf(run) !== 'running') return run
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())))
  }
  return loadIndex()[id]
}

// --- инструменты -----------------------------------------------------------

const describeRun = (run) => {
  const status = statusOf(run)
  const started = new Date(run.startedAt).getTime()
  const end = run.endedAt ? new Date(run.endedAt).getTime() : Date.now()
  return {
    id: run.id,
    status,
    pid: run.pid,
    exitCode: run.exitCode,
    runtimeSeconds: Math.round((end - started) / 1000),
    command: run.command,
    cwd: run.cwd,
    log: run.log,
  }
}

export default {
  id: 'monitored-shell',

  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: 'run',
        description:
          'Background command runner: full output always goes to a log file on disk, ' +
          'the agent reads deltas instead of holding a pipe.',
      })

      editor.add({
        name: 'run',
        description:
          'Start a shell command in the background. Its complete stdout+stderr is written to a log file ' +
          'that is never truncated, and the process survives the end of the turn or a client disconnect. ' +
          'Returns id, pid and log path. Follow with run_status (wait=N to observe every N seconds) ' +
          'or run_logs for full history. Errors are NOT auto-killed: run_status reports warnings for you to judge.',
        options: { namespace: 'run' },
        input: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command line, run through the shell.' },
            cwd: { type: 'string', description: 'Working directory. Defaults to the current one.' },
            label: { type: 'string', description: 'Optional human-readable id prefix, for example "build".' },
          },
          required: ['command'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { command, cwd, label } = input || {}
          if (!command || typeof command !== 'string') {
            return { content: 'error: command is required' }
          }
          const sessionID = context?.sessionID
          const started = startRun({
            command,
            cwd,
            label,
            onFinish: async ({ id, exitCode, label: runLabel }) => {
              if (!sessionID) return
              // Один пинг на завершение (вариант B). Агент может быть занят
              // другим — тогда это сообщение дождётся его в очереди сессии.
              try {
                await ctx.session.synthetic({
                  sessionID,
                  text:
                    `[run] ${id}${runLabel ? ` (${runLabel})` : ''} finished with exit code ${exitCode}. ` +
                    `Read the tail with run_status({ id: "${id}" }) or the full log with run_logs.`,
                })
              } catch {
                // Сессия могла закрыться — реестр на диске всё равно актуален.
              }
            },
          })
          const note = label ? ` (label: ${label})` : ''
          return {
            content: [
              `started${note}`,
              `id: ${started.id}`,
              `pid: ${started.pid}`,
              `log: ${started.log}`,
              '',
              'Next: run_status({ id, wait: 30 }) to observe, run_logs({ id }) for full output.',
            ].join('\n'),
          }
        },
      })

      editor.add({
        name: 'run_status',
        description:
          'Status of a run plus ONLY the lines appended since the previous call. ' +
          'Set wait=N to block up to N seconds (returns earlier when the process exits) — ' +
          'this is how to observe a long command every N seconds without burning turns. ' +
          'Use a large wait (600–1200) for slow builds. Budget about 70 KB of output per call ' +
          'regardless of wait. `warnings` lists lines that look like errors; that is material for your ' +
          'judgement, nothing is killed automatically.',
        options: { namespace: 'run' },
        input: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Run id from run.' },
            wait: {
              type: 'number',
              description: 'Max seconds to wait for new output or exit. Default 0 (no wait).',
            },
            maxLines: {
              type: 'number',
              description: 'Cap on returned delta lines (default 200, newest kept).',
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
        async execute(input) {
          const { id, wait = 0, maxLines = 200 } = input || {}
          const run = await waitFor(id, wait)
          if (!run) return { content: `error: no run "${id}"` }

          // Смещение хранится в реестре, поэтому дельта не зависит от истории чата.
          const offset = run.offset || 0
          const chunk = readLog(id, { offset })
          const got = sortLines(chunk.text)
          // Показываем новейшие строки, но честно сообщаем, сколько не влезло:
          // они в логе, и молча их проглотить — значит спрятать ошибку.
          const skipped = Math.max(0, got.length - maxLines)
          const lines = skipped ? got.slice(-maxLines) : got

          updateRun(id, { offset: chunk.next })

          const info = describeRun(run)
          const warnings = findWarnings(chunk.text)
          const header = [
            `id: ${info.id}`,
            `status: ${info.status}`,
            `exitCode: ${info.exitCode}`,
            `pid: ${info.pid}`,
            `runtime: ${info.runtimeSeconds}s`,
            `log: ${info.log}`,
            `newLines: ${lines.length}`,
          ]
          if (skipped) {
            header.push(
              `skippedLines: ${skipped} (earlier output not shown here; use run_logs with from_line or grep)`,
            )
          }
          if (chunk.next < chunk.size) {
            header.push(`unreadBytes: ${chunk.size - chunk.next} (call run_status again to continue)`)
          }
          if (warnings.length) {
            header.push('', 'warnings (not actioned):', ...warnings.map((w) => `  ${w}`))
          }
          if (info.status !== 'running') {
            header.push('', 'process is no longer running; use run_logs for the full history.')
          }
          const body = lines.length ? ['', ...lines].join('\n') : '\n(no new output)'
          return { content: header.join('\n') + body }
        },
      })

      editor.add({
        name: 'run_logs',
        description:
          'Read the full log of a run. Modes: tail (last N lines, default 200), grep (regex or literal), ' +
          'or from_line (skip the first N lines). Use it when you need something from the middle of a long ' +
          'log — the file is never truncated, so nothing has to be re-run.',
        options: { namespace: 'run' },
        input: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            mode: { type: 'string', enum: ['tail', 'grep', 'from_line'], description: 'Default tail.' },
            lines: { type: 'number', description: 'For tail: last N lines (default 200).' },
            pattern: { type: 'string', description: 'For grep: regular expression.' },
            from_line: { type: 'number', description: 'For from_line: first line to return (1-based).' },
            limit: { type: 'number', description: 'Cap on returned lines (default 400).' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        async execute(input) {
          const { id, mode = 'tail', lines = 200, pattern, from_line = 1, limit = 400 } = input || {}
          if (!existsSync(logPath(id))) return { content: `error: no log for "${id}"` }
          const full = readFileSync(logPath(id), 'utf8')
          const all = full.split('\n')

          if (mode === 'grep') {
            if (!pattern) return { content: 'error: pattern is required for grep' }
            let re
            try {
              re = new RegExp(pattern, 'i')
            } catch (error) {
              return { content: `error: bad pattern: ${error.message}` }
            }
            const hits = []
            all.forEach((line, index) => {
              if (re.test(line)) hits.push(`${index + 1}: ${line}`)
            })
            const kept = hits.slice(0, limit)
            return {
              content: kept.length
                ? `matches: ${hits.length} (showing ${kept.length})\n${kept.join('\n')}`
                : `no matches for /${pattern}/`,
            }
          }

          if (mode === 'from_line') {
            return { content: all.slice(Math.max(0, from_line - 1), Math.max(0, from_line - 1) + limit).join('\n') }
          }

          return { content: all.slice(-lines).join('\n') }
        },
      })

      editor.add({
        name: 'run_stop',
        description:
          'Stop a run: SIGTERM to its process group, then SIGKILL if it is still alive after the grace period. ' +
          'Also reports the exit code. The log stays on disk.',
        options: { namespace: 'run' },
        input: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            graceSeconds: { type: 'number', description: 'Wait before SIGKILL (default 10).' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        async execute(input) {
          const { id, graceSeconds = 10 } = input || {}
          const run = loadIndex()[id]
          if (!run) return { content: `error: no run "${id}"` }
          if (statusOf(run) !== 'running') return { content: `run "${id}" is not running (${statusOf(run)})` }

          const killGroup = (signal) => {
            try {
              process.kill(-run.pid, signal)
            } catch {
              try {
                process.kill(run.pid, signal)
              } catch {
                /* already gone */
              }
            }
          }

          killGroup('SIGTERM')
          const after = await waitFor(id, graceSeconds)
          if (after && statusOf(after) === 'running') {
            killGroup('SIGKILL')
            await waitFor(id, 2)
            return { content: `run "${id}": SIGTERM did not stop it, sent SIGKILL\nlog: ${run.log}` }
          }
          return { content: `run "${id}": stopped\nlog: ${run.log}` }
        },
      })

      editor.add({
        name: 'run_list',
        description: 'List runs (running first, then recent). Use it to pick an id or check for stale processes.',
        options: { namespace: 'run' },
        input: {
          type: 'object',
          properties: {
            all: { type: 'boolean', description: 'Include finished runs older than 24h (default false).' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const { all = false } = input || {}
          const index = loadIndex()
          const runs = Object.values(index).map(describeRun)
          const cutoff = Date.now() - 24 * 3600 * 1000
          const shown = runs
            .filter((r) => all || r.status === 'running' || new Date(index[r.id].endedAt || 0).getTime() > cutoff)
            .sort((a, b) => (a.status === 'running' ? -1 : 0) - (b.status === 'running' ? -1 : 0))
          if (!shown.length) return { content: 'no runs' }
          return {
            content: shown
              .map(
                (r) =>
                  `${r.id}  ${r.status.padEnd(7)} exit=${String(r.exitCode).padEnd(6)} ${String(r.runtimeSeconds).padStart(5)}s  ${r.command.slice(0, 80)}`,
              )
              .join('\n'),
          }
        },
      })

      editor.add({
        name: 'run_cleanup',
        description: 'Delete finished runs with their logs when older than N hours. Never touches running processes.',
        options: { namespace: 'run' },
        input: {
          type: 'object',
          properties: {
            olderThanHours: { type: 'number', description: `Default ${DEFAULT_RETENTION_HOURS}.` },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const hours = input?.olderThanHours ?? DEFAULT_RETENTION_HOURS
          const cutoff = Date.now() - hours * 3600 * 1000
          const index = loadIndex()
          const removed = []
          for (const [id, run] of Object.entries(index)) {
            if (statusOf(run) === 'running') continue
            const ended = run.endedAt ? new Date(run.endedAt).getTime() : new Date(run.startedAt).getTime()
            if (ended > cutoff) continue
            try {
              unlinkSync(logPath(id))
            } catch {
              /* log already gone */
            }
            delete index[id]
            removed.push(id)
          }
          if (removed.length) saveIndex(index)
          return { content: removed.length ? `removed ${removed.length}: ${removed.join(', ')}` : 'nothing to remove' }
        },
      })
    })
  },
}
