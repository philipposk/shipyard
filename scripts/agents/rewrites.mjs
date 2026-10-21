// Claude Code only wording in skills/, rewritten for the Codex and Cursor copy of the skills.
// Each row replaces one exact piece of a source file, in place, so the copy never holds two
// instructions that disagree. A test checks that every `find` still occurs exactly once in its source:
// when a skill file changes, update the row here.
//
// `file` is relative to skills/. `find` is a string, or a RegExp for a whole section.
// `replace` may use {{ROOT}} (the Shipyard folder) and {{SKILLS_DIR}} (where the copy is installed).
// Rule of thumb: "Claude" naming the agent becomes "you" when the text speaks to the agent, and
// "your coding agent" when the student will read it.

const SEE = ' (open the image files; if you cannot see images, ask the student to open them and say what they see)';
const HABITS_WHERE =
  'Codex: add it to `$CODEX_HOME/AGENTS.override.md` if that file exists, otherwise to `$CODEX_HOME/AGENTS.md` (`$CODEX_HOME` is `~/.codex` unless it is set). Create the file if it is missing, never overwrite what is there, and put the text between the lines `<!-- shipyard habits start -->` and `<!-- shipyard habits end -->`. If those lines are already there, do not add it again. Cursor: you cannot change its rules yourself, so show the text and ask the student to paste it into Cursor Settings, Rules, User Rules.';

export const REWRITES = [
  // ---------- setup ----------
  {
    id: 'S2',
    file: 'setup/SKILL.md',
    find: '- Do not spawn big groups of helper agents. If you use one (for example to look something up), give it a cheaper model than yours (Opus → `model: "sonnet"`, Sonnet → `model: "haiku"` for lookups only).',
    replace: '- Do not spawn big groups of helper agents. If your agent can use one (for example to look something up), give it a smaller, cheaper model than yours, for lookups only.',
  },
  {
    id: 'S3',
    file: 'setup/SKILL.md',
    find: 'If the student typed `settings` after the command,',
    replace: 'If the student asked for the settings page (for example typed `settings` after the skill name),',
  },
  {
    id: 'S4',
    file: 'setup/SKILL.md',
    find:
      '**10. `habits`** Why: a few working habits make Claude Code cheaper and safer.\n' +
      'Show them the content of `${CLAUDE_PLUGIN_ROOT}/starter/CLAUDE.md`. Ask: "Add this to your global Claude settings file?" Only if they say yes, append it to `~/.claude/CLAUDE.md` (create the file if missing; never overwrite existing content).',
    replace:
      '**10. `habits`** Why: a few working habits make your coding agent cheaper and safer.\n' +
      `Show them the content of \`{{ROOT}}/scripts/agents/habits.md\`. Ask: "Add these habits to your coding agent's settings?" Only if they say yes: ${HABITS_WHERE}`,
  },
  {
    id: 'S5',
    file: 'setup/SKILL.md',
    find: '3. Tell them to turn on updates: type `/plugin`, choose Marketplaces, choose shipyard, choose Enable auto-update.',
    replace: '3. Tell them how to update Shipyard: in a terminal, `node "{{ROOT}}/scripts/install-agents.mjs" --update`, about once a month.',
  },
  {
    id: 'S6',
    file: 'setup/SKILL.md',
    find: 'Claude Pro and ChatGPT Plus do not include API credit.',
    replace: 'Chat and coding-agent plans (ChatGPT, Cursor and others) do not include API credit.',
  },
  {
    id: 'A1',
    file: 'setup/references/accounts.md',
    find: 'Claude Pro limits are shared with claude.ai chat; on build days skip the chat and check `/usage`.',
    replace: "Your coding agent's plan has usage limits. On build days keep other chats on the same plan short, and check what is left in the agent's own usage screen.",
  },
  {
    id: 'A2',
    file: 'setup/references/accounts.md',
    find: 'Windows: Claude Code already needs Git for Windows.',
    replace: 'Windows: Codex and Cursor do not install Git. If `check-tools` says Git is missing, install Git for Windows from git-scm.com and reopen the agent.',
  },
  {
    id: 'A3',
    file: 'setup/references/accounts.md',
    find: '`starter/CLAUDE.md` is only added to `~/.claude/CLAUDE.md` after they see it and say yes.',
    replace: `\`{{ROOT}}/scripts/agents/habits.md\` is only added after they see it and say yes. ${HABITS_WHERE}`,
  },
  {
    id: 'T1',
    file: 'setup/references/troubleshooting.md',
    find: 'Use the terminal Claude Code runs in.',
    replace: 'Use the terminal your coding agent runs commands in.',
  },

  // ---------- new-app ----------
  {
    id: 'N1',
    file: 'new-app/SKILL.md',
    find: /- Save the student's usage: give helper agents one model cheaper than yours[^\n]*/,
    replace:
      '- Save the student\'s usage: if your agent can use helper agents, give them a smaller, cheaper model than yours, and only mechanical work (builds, test runs, searches, doc and copy edits, simple UI fixes). Keep sign-in, data privacy (RLS), keys, payments and the final check on your own model. At most a couple of helpers at a time, and re-check their "done" yourself.',
  },
  {
    id: 'N2',
    file: 'new-app/SKILL.md',
    find: 'Otherwise run the design skill and ask its one question',
    replace: 'Otherwise read `{{SKILLS_DIR}}/shipyard-design/SKILL.md`, follow it, and ask its one question',
  },
  {
    id: 'N3a',
    file: 'new-app/SKILL.md',
    find: 'Look at the two phone screenshots it saves (light and dark)',
    replace: `Look at the two phone screenshots it saves (light and dark)${SEE}`,
  },
  {
    id: 'N4',
    file: 'new-app/SKILL.md',
    find: '`/shipyard:launch` sets that up."',
    replace: 'Shipyard launch sets that up (ask your coding agent: `$shipyard-launch` in Codex, `/shipyard-launch` in Cursor)."',
  },
  {
    id: 'N5',
    file: 'new-app/SKILL.md',
    find: 'a lot of Claude usage',
    replace: "a lot of your plan's usage",
  },

  // ---------- design ----------
  {
    id: 'N3b',
    file: 'design/SKILL.md',
    find: 'Look at the images, read `references/tokens.md`',
    replace: `Look at the images${SEE}, read \`references/tokens.md\``,
  },
  {
    id: 'N3c',
    file: 'design/SKILL.md',
    find: 'Look at the screenshots and the draft,',
    replace: `Look at the screenshots${SEE} and the draft,`,
  },
  {
    id: 'N3d',
    file: 'design/SKILL.md',
    find: 'look at the light and dark phone screenshots yourself.',
    replace: `look at the light and dark phone screenshots yourself${SEE}.`,
  },
  {
    id: 'PL0',
    file: 'design/references/polish.md',
    find: "Installing changes the student's Claude Code, and a restart or reload is needed afterwards.",
    replace: "Installing changes the student's coding agent, and a reload is needed afterwards.",
  },
  {
    id: 'PL1',
    file: 'design/references/polish.md',
    find: /## Baseline: frontend-design \(official, free\)\n[\s\S]*?(?=\n## After the first real build)/,
    replace: '## frontend-design (Claude Code only)\n\nSkip it here.\n',
  },
  {
    id: 'PL2',
    file: 'design/references/polish.md',
    find: 'with the page open in front of Claude. Warning to say out loud: it can use a lot of the Claude Pro allowance,',
    replace: "with the page open in front of you. Warning to say out loud: it can use a lot of the student's plan usage,",
  },
  {
    id: 'PL3',
    file: 'design/references/polish.md',
    find: /Install, either way \(verified in its README\):\n[\s\S]*?It also installs hooks that run when files are edited; mention that\./,
    replace:
      'Install, from the app folder:\n```\nnpx impeccable install\n```\n' +
      '(it asks where to install; `npx impeccable update` refreshes it; needs Node.) Run `npx impeccable install --help` first and use the provider it lists for Codex or Cursor; if neither is listed, skip Impeccable. Reload the agent afterwards. The first time, run its `init` command the way its install message shows for your agent.\n\n' +
      'Useful commands: `critique` (review of hierarchy and clarity), `audit` (technical quality), `polish` (final pass), started the way your agent starts skills. It may also add hooks that run when files are edited; mention that.',
  },
  {
    id: 'PL4',
    file: 'design/references/polish.md',
    find: /Verified commands:\n```\n\/plugin marketplace add nextlevelbuilder\/ui-ux-pro-max-skill\n[\s\S]*?if the global install gives a permissions error\)\./,
    replace:
      'Use the project\'s own CLI: `npm install -g ui-ux-pro-max-cli` then, in the app folder, `uipro init --ai <your agent>` (check `uipro init --help` for codex or cursor; skip it if neither is listed). `npx ui-ux-pro-max-cli init --ai <your agent>` works if the global install gives a permissions error.',
  },
  {
    id: 'TK1',
    file: 'design/references/tokens.md',
    find: '`dark-from-light.mjs` in `scripts/design/` does this for tokens.',
    replace: '`{{ROOT}}/scripts/design/dark-from-light.mjs` does this for tokens.',
  },

  // ---------- launch ----------
  {
    id: 'L1',
    file: 'launch/SKILL.md',
    find: '- Helper agents: one model cheaper than yours, mechanical work only (same rule as new-app).',
    replace: '- Helper agents, if your agent has them: a smaller, cheaper model, mechanical work only.',
  },
  {
    id: 'L2',
    file: 'launch/SKILL.md',
    find: "offer the upgrade in new-app's `references/upgrade.md` first.",
    replace: 'offer the upgrade in `{{SKILLS_DIR}}/shipyard-new-app/references/upgrade.md` first.',
  },
  {
    id: 'C1',
    file: 'launch/references/country.md',
    find: "Search the web for the student's country plus the topic and open only:",
    replace: "Search the web for the student's country plus the topic if you can. If you cannot, ask the student to open the official pages and paste the relevant lines. Use only:",
  },

  // ---------- video ----------
  {
    id: 'V1',
    file: 'video/SKILL.md',
    find: '- Verify with your own eyes: look at stills and the contact sheet with the Read tool.',
    replace: '- Verify with your own eyes: open the image files of the stills and the contact sheet and look at them (if you cannot see images, say so).',
  },
  {
    id: 'V2',
    file: 'video/SKILL.md',
    find: "a big share of a Pro plan's usage",
    replace: "a big share of the student's plan",
  },
  {
    id: 'V3',
    file: 'video/SKILL.md',
    find: 'Read the contact sheet picture it prints (Read tool) to confirm',
    replace: 'Open the contact sheet picture it prints and look at it (if you cannot see images, say so) to confirm',
  },
  {
    id: 'V4',
    file: 'video/references/qa-render.md',
    find: 'Open each sheet with the Read tool and look.',
    replace: 'Open each sheet image file and look at it (if you cannot see images, say so).',
  },

  // ---------- ops ----------
  {
    id: 'O1',
    file: 'ops/SKILL.md',
    find: '- Helper agents: one model cheaper than yours, mechanical work only (listing files, running checks).',
    replace: '- Helper agents, if your agent has them: a smaller, cheaper model, mechanical work only (listing files, running checks).',
  },
  {
    id: 'O2',
    file: 'ops/SKILL.md',
    find: "use the student's Claude Pro allowance.",
    replace: "use the student's coding-agent plan.",
  },
  {
    id: 'R1',
    file: 'ops/references/review.md',
    find: '## Option B: free, inside Claude Code',
    replace: '## Option B: free, with your coding agent',
  },
  {
    id: 'R2',
    file: 'ops/references/review.md',
    find: "Before merging, run `/code-review` in Claude Code on the branch (it reviews the current changes). No extra account, uses the student's Pro allowance.",
    replace: 'Before merging, ask your coding agent on the branch: "Review the changes on this branch against main and list real bugs only." No extra account, uses the student\'s plan.',
  },
  {
    id: 'R3',
    file: 'ops/references/review.md',
    find: '1. Open Claude Code in the repo,',
    replace: '1. Open your coding agent in the repo,',
  },
  {
    id: 'H1',
    file: 'ops/references/self-healing.md',
    find: "**Open Claude Code in the app's folder**",
    replace: "**Open your coding agent in the app's folder**",
  },
  {
    id: 'H2',
    file: 'ops/references/self-healing.md',
    find: "If the student's Claude desktop app offers pull-request auto-fix or scheduled tasks on their plan, those can start the loop for them. Check what their app actually shows; do not promise a feature.",
    replace: '(Claude Code only: pull-request auto-fix and scheduled tasks in its desktop app. Skip this here.)',
  },
  {
    id: 'H3',
    file: 'ops/references/self-healing.md',
    find: /## Advanced, optional: Claude inside GitHub Actions\n[\s\S]*?(?=\n## |$)/,
    replace: '## Advanced, optional: fixes inside GitHub Actions\n\nClaude Code only. Skip it in Codex and Cursor, and say so in one line if asked.\n',
  },
  {
    id: 'P1',
    file: 'ops/references/project-review.md',
    find: 'when there is spare Claude allowance.',
    replace: 'when there is spare plan usage.',
  },
  {
    id: 'P2',
    file: 'ops/references/project-review.md',
    find: "A review uses a lot of the student's Claude Pro allowance (it reads the whole project). Run it when they have room, not right before they need Claude for something else.",
    replace: "A review uses a lot of the student's plan usage (it reads the whole project). Run it when they have room, not right before they need their coding agent for something else.",
  },
  {
    id: 'P3',
    file: 'ops/references/project-review.md',
    find: '2. Use your strongest model for judgement: what is a real problem, what is a risk, what to fix first. You may use helper agents one model cheaper for mechanical work only:',
    replace: '2. Keep the judgement yourself: what is a real problem, what is a risk, what to fix first. If your agent has helper agents, you may give them a smaller, cheaper model for mechanical work only:',
  },
  {
    id: 'P4',
    file: 'ops/references/project-review.md',
    find: 'A lighter option: ask Claude to review',
    replace: 'A lighter option: ask your coding agent to review',
  },
  {
    id: 'P5',
    file: 'ops/references/project-review.md',
    find: "If the student's Claude plan offers scheduled tasks in the desktop app, they can set a monthly reminder to run this. Do not promise it exists; check what their plan shows.",
    replace: "If the student's coding agent can run scheduled tasks, offer it; otherwise skip.",
  },
  {
    id: 'B1',
    file: 'ops/references/backups.md',
    find: 'Never open or print the backup files in the chat, `manifest.json` included. The secrets guard blocks reading anything under `~/.shipyard/backups/` (reading, searching, `cat`, `jq`, `node -e`); listing folder names with `ls` and deleting old ones with `rm` still work, and the script prints the row counts itself.',
    replace: 'Never read, search or print anything under `~/.shipyard/backups/` (no `cat`, `jq`, `node -e`), `manifest.json` included; `ls` and `rm` are fine, and the script prints the row counts itself. The Shipyard guard blocks these when it is on.',
  },
  {
    id: 'B2',
    file: 'ops/references/backups.md',
    find: '2. Claude never opens the backup files, because they hold users\' personal data and the guard blocks it. Instead Claude writes a small script',
    replace: '2. You never open the backup files, because they hold users\' personal data and the guard blocks it. Instead you write a small script',
  },
];
