import { Logger } from '@nestjs/common';
import { spawn, execSync } from 'child_process';

export interface CliResult {
  result: string;
  total_cost_usd: number;
  num_turns: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

const logger = new Logger('TeamCLI');

/**
 * Runs a team lead prompt via `claude -p` CLI with agent teams enabled.
 *
 * After the CLI process exits, force-cleans any orphaned tmux sessions
 * and team files to prevent shutdown loops from blocking the pipeline.
 */
export function runTeamViaCli(
  prompt: string,
  teamName: string,
  logPrefix: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'bypassPermissions',
        '--dangerously-skip-permissions',
        '--max-turns', '40',
      ],
      {
        env: {
          ...process.env,
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        cwd: process.cwd(),
      },
    );

    let lastResult: CliResult | null = null;
    let buffer = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          logStreamMessage(msg, logPrefix);

          if (msg.type === 'result') {
            lastResult = {
              result: msg.result ?? '',
              total_cost_usd: msg.total_cost_usd ?? 0,
              num_turns: msg.num_turns ?? 0,
              usage: {
                input_tokens: msg.usage?.input_tokens ?? 0,
                output_tokens: msg.usage?.output_tokens ?? 0,
              },
            };
          }
        } catch {
          // non-JSON line
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logger.warn(`[${logPrefix} stderr] ${text}`);
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      forceCleanup(teamName, logPrefix);
      settle(() => reject(new Error(`${logPrefix} timed out after 20 minutes`)));
    }, 20 * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      logger.log(`[${logPrefix}] CLI process exited with code ${code}`);
      forceCleanup(teamName, logPrefix);
      settle(() => {
        if (lastResult) {
          resolve(lastResult);
        } else {
          reject(new Error(`CLI exited with code ${code} and no result`));
        }
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      forceCleanup(teamName, logPrefix);
      settle(() => reject(err));
    });
  });
}

/**
 * Force-kills any orphaned tmux sessions and removes team files.
 * Called automatically after every team CLI run — ensures no leftover processes.
 */
function forceCleanup(teamName: string, logPrefix: string): void {
  try {
    // Kill tmux sessions matching the team name
    const tmuxSessions = execSync('tmux ls 2>/dev/null || true', { encoding: 'utf-8' });
    const lines = tmuxSessions.split('\n').filter(l => l.includes(teamName));
    for (const line of lines) {
      const sessionName = line.split(':')[0];
      try {
        execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null || true`);
        logger.log(`[${logPrefix}] Killed orphaned tmux session: ${sessionName}`);
      } catch {
        // ignore
      }
    }

    // Remove team files
    const homeDir = process.env.HOME ?? '';
    execSync(`rm -rf "${homeDir}/.claude/teams/${teamName}" "${homeDir}/.claude/tasks/${teamName}" 2>/dev/null || true`);
    logger.log(`[${logPrefix}] Cleaned up team files: ${teamName}`);
  } catch {
    // cleanup is best-effort — don't fail the pipeline
  }
}

function logStreamMessage(msg: any, prefix: string): void {
  const type = msg.type;
  const subtype = msg.subtype ?? '';

  if (type === 'system' && subtype === 'init') {
    logger.log(`[${prefix}] Session started | model: ${msg.model}`);
    return;
  }

  if (type === 'assistant') {
    const blocks: any[] = msg.message?.content ?? [];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const input = JSON.stringify(block.input ?? {}).slice(0, 150);
        logger.log(`[${prefix}] 🔧 ${block.name}(${input})`);
      }
      if (block.type === 'text' && block.text?.trim()) {
        logger.log(`[${prefix}] 💬 ${block.text.slice(0, 250)}`);
      }
    }
    return;
  }

  if (type === 'user') {
    const toolResult = msg.tool_use_result;
    if (toolResult?.team_name || toolResult?.from) {
      logger.log(`[${prefix}] 📨 ${JSON.stringify(toolResult).slice(0, 250)}`);
    }
    return;
  }

  if (type === 'result') {
    logger.log(`[${prefix}] 🏁 Result: turns=${msg.num_turns} cost=$${msg.total_cost_usd?.toFixed(4)} status=${subtype}`);
  }
}
