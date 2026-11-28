export const COMMAND_OPERATIONS = Object.freeze({
  'mathlib-search': { search: 'mathlib_search' },
  agent: { exit: 'agent_exit' },
  task: { create: 'task_create', list: 'task_list', view: 'task_view', take: 'task_take', finish: 'task_finish', feedback: 'task_feedback', link: 'task_link_material', status: 'task_status', revise: 'task_revise', cancel: 'task_cancel', 'dependency-replace': 'task_dependency_replace' },
  material: { list: 'read_materials', view: 'context_get_material', search: 'context_search_materials', publish: 'context_publish_material', consume: 'consume_materials', dispute: 'material_dispute', supersede: 'material_supersede', unsupersede: 'material_unsupersede' },
  workspace: { view: 'workspace_public_view', history: 'workspace_public_history', status: 'workspace_status', diff: 'workspace_current_diff', 'public-diff': 'workspace_public_diff', files: 'workspace_public_files', read: 'workspace_public_read', search: 'workspace_public_search', save: 'workspace_save', apply: 'workspace_apply', merge: 'workspace_merge' },
  mission: { view: 'mission_get', submit: 'mission_submit', 'submission view': 'mission_submission_get' },
  judge: { check: 'workspace_check', result: 'get_check_result' },
});

export function transportService(service: string) { return service === 'material' ? 'context' : service === 'agent' ? 'task' : service; }

const commands: Readonly<Record<string, Readonly<Record<string, string>>>> = COMMAND_OPERATIONS;

function serviceAliases(service: string) {
  return Object.hasOwn(commands, service) ? commands[service] : {};
}

export function operationForCommand(service: string, command: string): string | undefined {
  const aliases = serviceAliases(service);
  return Object.hasOwn(aliases, command) ? aliases[command] : undefined;
}

export function serviceCommand(service: string, operation: string): string {
  const group = service === 'context' ? 'material' : service === 'task' && operation === 'agent_exit' ? 'agent' : service;
  const aliases = serviceAliases(group);
  const alias = Object.keys(aliases).find(command => aliases[command] === operation);
  if (service === 'material' || service === 'service' || (group === 'mission' && operation === 'submission') ||
      (!alias && operationForCommand(group, operation))) {
    return `swarm service invoke ${service} ${operation}`;
  }
  const command = alias ?? operation;
  return `swarm ${group} ${command}`;
}

const TASK_COMMANDS = Object.keys(COMMAND_OPERATIONS.task).join('|');
const WORKSPACE_FILES_HELP = 'List public paths. Use --at R (main is allowed), an optional positional path prefix, --limit or --cursor. Example: swarm workspace files --at 0.1 --limit 20';
const COMMAND_HELP = Object.freeze({
  agent: { exit: 'End an unbound Agent with no pending take after the selection budget expires. Use --reason selection-budget. For an open Mission with selection time left, inspect current public state and existing Tasks within the selection budget. The Core is released after cleanup.' },
  task: {
    create: `Propose a concrete missing deliverable when the host enables autonomous Tasks. An active Agent keeps its current Execution.
Required: --summary, --gap, --expected-output, --priority (high, medium, or low), and --acceptance-conditions (a nonempty JSON array or object).
  swarm task create --summary "Check a boundary case" --gap "The current argument leaves one case open" --expected-output "A reproducible check" --acceptance-conditions '["State the inputs and result"]' --priority medium --request-id propose-boundary
Replace the example with your actual proposal. You can also pass the same fields in JSON through --input or --stdin. The Service binds the Mission and Workspace. The result includes task.task_id. Use that ID with swarm task take if you choose to claim it.
Use swarm service view task --json to see the enabled operations and complete input schemas.`,
    list: `Search Task summaries using --query, --limit (1-100) and --cursor. Omit the state filter to include all states, use --state for one state, or pass a quoted JSON array to --states.
  swarm task list --state ready
  swarm task list --states '["ready","running","blocked","done","canceled"]'
Candidate summaries include gap and priority; inspect their relevance and choose freely. Follow next_cursor even after an empty page, then view Task details before taking. Creation order is stable within a scan; state and readiness are live at each page.`,
    view: 'Required: <task-id> (or --task-id). Read a Task contract, gap, priority, versions, dependencies, Materials and Executions. Use --contract-history-after-version and --contract-history-limit (1-100) to continue contract_history_page.next_after_version.',
    take: 'Take an eligible Task by its positional ID. Example: swarm task take T1 --request-id take-t1 (replace T1 with the returned task_id). The result includes the Execution and pinned inputs. If the response is unknown, reuse the same request ID with the same Task.',
    link: `Link a published Material during an active Execution. The role determines which Task ID to use.
To send your published Material to another Task, use the receiving Task's ID in --task-id and choose --role response. The authenticated Execution supplies the producer. Omit --receiving-task-id, or give it the same ID as --task-id. TaskPool queues a notice for the receiving Task.
  swarm task link --task-id RECEIVING_TASK_ID --material-id MATERIAL_ID --role response --request-id send-m1-to-recipient
To attach Material as input to your own work, use --role input and your current Task's ID. To cite your own published Material when finishing, link it to your current Task with --role experience.
  swarm task link --task-id CURRENT_TASK_ID --material-id MATERIAL_ID --role experience --request-id link-m1-to-current
Replace each placeholder with the corresponding actual ID. Response and handoff links require the producing Execution.`,
    finish: `Finish the current Task with outcome done, incomplete, blocked, or cancelled. For a declared Workspace delivery, provide --workspace-revision and any required --check-result-id.
Publication records who produced a Material. To explicitly cite that Material in a done result, first create a Task link with swarm task link.
Example after linking: swarm task finish --outcome done --material-ids '["M1"]' --request-id finish-t1
Use a quoted JSON array of actual Material IDs. Omit this optional list when your checked Workspace revision and other evidence already satisfy the Task's completion contract. Required deliverables still apply.`,
    revise: 'An UNBOUND Agent can revise an open, unowned Task, including a previously executed Task. Use <task-id> --expected-spec-version N --expected-state-version N --reason TEXT --changes JSON (or --input/--stdin). Changes include summary, gap, expected_output, acceptance_conditions, priority and optional inputs/dependencies. Example: --changes \'{"priority":"high"}\'. Read current versions first; running, preparing, cleaning up and closed responsibilities are protected. Old Executions retain their original contract.',
    cancel: 'An UNBOUND Agent can cancel an open, unowned Task with <task-id> --expected-spec-version --expected-state-version --reason and optional --replacement. Cancellation preserves history and does not satisfy dependencies. No extra coordination grant is required.',
    'dependency-replace': 'Repair a cancelled prerequisite of an unowned blocked Task. Required: <task-id> --from-task-id --to-task-id --expected-spec-version --expected-state-version --reason. Requires a Mission coordination grant.',
    feedback: 'Record handling of a notice for your current Task. Use --notification-id, --decision (for example adopted or rejected), --action and optional --details JSON. Use swarm service view task --json for the contract.',
  },
  material: {
    list: 'Read bounded Material summaries using --query, --task-id, --limit and --cursor; follow next_cursor even after an empty page.',
    view: 'Read one immutable Material including provenance and corrections. Required: <material-id>.',
    search: 'Search Materials. Input: --query and explicit scope filters.',
    publish: `Publish immutable Material from your current Execution with --content and optional --title and --summary. For saved code, put its fixed revision, file, declaration, and verification outcome in structured content.
  swarm material publish --content '{"revision":"0.2","path":"lean4/src/Proof/Geometry.lean","declaration":"proof_lemma","check_status":"pass","check_result_id":"CHECK_ID"}' --request-id publish-lemma
Use revision and check information from your actual receipts. Read the returned material.material_id. To notify a different Task, use swarm task link --role response with the receiving Task ID and that Material ID. See swarm task link --help.`,
    dispute: 'Question a Material. Required: <material-id> --reason --claim; claim identifies the affected claim or section.',
    supersede: 'Replace a whole Material. Required: <old-id> --with <new-id> --expected-version <observed relation_version> --reason.',
    unsupersede: 'Revoke only the matching replacement. Required: <old-id> --with <new-id> --expected-version <observed relation_version> --reason. Preserves history.',
    consume: `Record a meaningful Material use in the current Execution. Pass --material-ids as a quoted JSON array of 1–100 unique IDs, even for a single ID.
Allowed --action values: route, task, workspace, integration. Use --impact to describe what changed because of the Material.
Example: swarm material consume --material-ids '["M1"]' --action integration --impact "Used M1 to choose the boundary case in the integrated proof." --request-id use-m1
Replace M1 with an actual Material ID. After an unknown response, reuse the same request ID and payload.`,
  },
  workspace: {
    view: 'Read the current public Workspace and main.',
    history: 'Read main history; --all includes unmerged saves. Filter --task, --execution, --material-id, --path; paginate with --limit and --cursor.',
    status: 'Inspect current E initial input, saved revision, dirty paths and conflicts.',
    diff: 'Compare the current Execution project against its last save. To compare two fixed public revisions, use swarm workspace public-diff --from R --to R. The original diff --from R --to R form also works.',
    'public-diff': 'Compare two fixed public revisions, including unmerged saves. Use --from R --to R and optional --path, --limit or --cursor.',
    files: WORKSPACE_FILES_HELP,
    read: 'Read one public file by its positional path. Use --at R (main is allowed) and optional --max-bytes. Example: swarm workspace read notes.txt --at 0.1 (choose a path from workspace files).',
    search: 'Search public paths and UTF-8 text at --at R; paginate with --max-results and --cursor.',
    save: `Save the actual current E project as a stable public revision. Use --resolved only after resolving recorded conflicts and removing their alternatives. To cite Materials in the saved revision, first record each use in this Execution with swarm material consume --action workspace. Then pass up to 20 distinct IDs as --material-ids '["M1"]'. No file, identity or lineage arguments. Reuse --request-id after an unknown response.`,
    apply: 'First save your own changes. Apply refuses a dirty project. Use --from a fixed public revision to integrate its files into this Execution. Resolve recorded conflicts and save --resolved. Retry the original request ID after an unknown response.',
    merge: 'Merge --from a fixed public revision; Runtime pins main, checks the combined tree when configured, and conditionally advances main. For a configured 3-minute project check, use --timeout-ms 210000 to wait for its response. After response loss, repeat the same --from and --request-id to recover the original operation; do not assume the merge failed or start a new request.',
  },
  mission: {
    view: 'Read the current Mission goal and acceptance conditions through the trusted Agent binding.',
    submit: 'Submit current main plus an explicit Material selection using --materials M1,M2 (or --materials [] for files only). Requires a Mission coordination grant. The service fixes the checker, configuration and main. Use a stable --request-id, then use swarm mission submission view with that ID to follow the accepted submission or recover a lost response.',
    'submission view': 'Read Mission submission state and immutable snapshots.',
  },
  judge: {
    check: `Check a saved public Workspace revision with --revision R. When the project checker is configured, Lake builds the revision's Lean modules, including local imports. Find the locked target path with swarm mission view. Keep Lean sources under the target's source directory, and import siblings by module name relative to that directory. Example: if the target is lean4/src/Main.lean, save lean4/src/Proof/Geometry.lean and write import Proof.Geometry. Judge uses its trusted project configuration.
For iteration on a local proposition, save its module and use --revision R --check-mode lean-module --path P. This checks that whole module and its necessary dependencies, with actual scope and cache evidence in the receipt; it does not select an individual declaration within a multi-declaration file. Independently useful lemmas and definitions may live in separate imported modules to keep iteration focused. A local PASS is not a whole-project or Mission PASS. Without this mode, --path P identifies a delivery file and still builds the whole project. The selected file must satisfy the delivery source policy. Legacy single-file checkers require --path.
A build result is diagnostic. A check without --path does not supply a Task delivery file receipt. Mission acceptance separately validates the locked target proof on a fixed tree.
--timeout-ms controls how long the CLI waits for HTTP. The service controls the checker's execution limit. Without a deployment override the HTTP wait is 30 seconds; the effective default is shown below and may be too short for a cold module build. For a 10-minute source phase with preflight already ready and no queue wait, use --timeout-ms 630000. Allow additional time for queue waiting and cold preflight; changing HTTP wait never extends Execution or checker deadlines.
Use a stable --request-id. After a lost response, use swarm judge result --request-key with the original ID, or repeat the same request with the same ID.`,
    result: 'Read one CheckResult. Use --check-result-id or --request-key; request-key lookup survives a lost submit response.',
  },
});

function commandInput(service: string, command: string, args: string[], input: Record<string, any>) {
  const fields = {
    task: { view: 'task_id', take: 'task_id', revise: 'task_id', cancel: 'task_id', 'dependency-replace': 'task_id' },
    material: { view: 'material_id', search: 'query', dispute: 'material_id', supersede: 'material_id', unsupersede: 'material_id' },
    workspace: { files: 'path', read: 'path', search: 'query' },
    judge: { result: 'check_result_id' },
    mission: { 'submission view': 'submission_id' },
  };
  const field = (fields as Record<string, any>)[service]?.[command];
  if (args.length > (field ? 1 : 0)) throw new Error('unexpected positional arguments');
  if (args.length) {
    if (input[field] !== undefined && input[field] !== args[0]) throw new Error(`conflicting ${field}`);
    input[field] = args[0];
  }
  const rename = (from: any, to: any) => {
    if (input[from] === undefined) return;
    if (input[to] !== undefined && input[to] !== input[from]) throw new Error(`conflicting ${to}`);
    input[to] = input[from]; delete input[from];
  };
  if (service === 'workspace' || service === 'judge') rename('at', 'revision');
  if (service === 'workspace' && command === 'history') { rename('task', 'producer_task_id'); rename('execution', 'producer_execution_id'); }
  if (service === 'material' && ['supersede', 'unsupersede'].includes(command)) rename('with', 'replacement_material_id');
  if (service === 'workspace' && command === 'save' && typeof input.material_ids === 'string') input.material_ids = input.material_ids.split(',').filter(Boolean);
  if (service === 'mission' && command === 'submit') {
    rename('materials', 'material_ids');
    if (typeof input.material_ids === 'string') input.material_ids = input.material_ids.split(',').filter(Boolean);
    if (!Array.isArray(input.material_ids)) throw new Error('mission submit requires an explicit --materials selection, including [] for files only');
  }
  if (service === 'task' && ['finish', 'cancel'].includes(command)) rename('replacement', 'replacement_task_id');
  return input;
}

export const taskPoolCommands = {
  services: ['task', 'agent', 'material', 'workspace', 'mission', 'judge', 'catalog'],
  aliases: COMMAND_OPERATIONS,
  help: COMMAND_HELP,
  hiddenGroups: ['context'],
  overview: [
    `  task ${TASK_COMMANDS}`,
    '  material list|view|search|publish|consume|dispute|supersede|unsupersede',
    '  workspace view|history|status|diff|public-diff|files|read|search|save|apply|merge',
    '  mission view|submit|submission view',
    '  judge check|result',
  ].join('\n'),
  transportService,
  transformInput: commandInput,
  groupHelp: (service: string) => service === 'task' ? `Commands: ${TASK_COMMANDS}. See swarm service view task --json for the operations enabled by the host.` : undefined,
  extendedHelp: (service: string, command: string) => service === 'mission' && command === 'submission'
    ? 'Usage: swarm mission submission view [id] [--json]\nWithout an ID, read current Mission state and its submissions. With an ID, read that submission and its fixed inputs.'
    : undefined,
  parseCommand(service: string, command: string, args: string[]) {
    if (service === 'mission' && command === 'submission') {
      if (args[0] !== 'view') throw new Error('mission submission requires view [id]');
      return { command: 'submission view', args: args.slice(1) };
    }
    return { command, args };
  },
  selectOperation(service: string, command: string, operation: string, input: Record<string, any>) {
    if (service === 'workspace' && command === 'diff' && (input.from !== undefined || input.to !== undefined)) {
      if (typeof input.from !== 'string' || typeof input.to !== 'string' || !input.from || !input.to) throw new Error('public Workspace diff requires both --from and --to');
      return 'workspace_public_diff';
    }
    return operation;
  },
  timeout: (operation: string) => ['workspace_check', 'workspace_merge', 'mission_submit'].includes(operation)
    ? process.env.MURM_CLI_CHECK_REQUEST_TIMEOUT_MS : undefined,
  requestLabel: (operation: string) => operation === 'task_take' ? 'take' : operation,
};
