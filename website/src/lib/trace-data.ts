export type SpanLane = 'input' | 'context' | 'model' | 'tool' | 'service';

export type EventKind = 'USER' | 'CONTEXT' | 'ASSISTANT' | 'TOOL' | 'SERVICE' | 'SYSTEM';

export interface TimelineSpan {
  id: string;
  agent: string;
  lane: SpanLane;
  startSec: number;
  endSec: number;
  turnId: string;
  label: string;
  detail?: string;
}

export interface TraceEvent {
  id: string;
  kind: EventKind;
  summary: string;
  timestamp: string;
  durationMs?: number;
  tokens?: string;
  handoffTo?: string;
  handoffFrom?: string;
  payload?: Record<string, unknown> | string;
}

export interface TraceTurn {
  id: string;
  turnNumber: number;
  agent: string;
  role: string;
  startSec: number;
  endSec: number;
  outcome: 'completed' | 'interrupted' | 'failed';
  events: TraceEvent[];
}

export interface RunTrace {
  id: string;
  title: string;
  program: string;
  subtitle: string;
  durationSec: number;
  status: string;
  metrics: { label: string; value: string }[];
  agents: { id: string; role: string; color: string; turns: number; calls: number }[];
  spans: TimelineSpan[];
  turns: TraceTurn[];
}

export const BUILTIN_TRACES: RunTrace[] = [
  {
    id: 'subagents-fd',
    title: 'Subagents · ProgramBench fd',
    program: 'subagents',
    subtitle: 'EXP-20261125-10 实测回放：3 个 Agent 共享工作区并行重建 fd 10.3.0，含中途用户补充与字节级测试交接',
    durationSec: 2635,
    status: 'SETTLED · 84.37% (1,042 / 1,235)',
    metrics: [
      { label: 'Duration', value: '43m 54s' },
      { label: 'Agents', value: '3 (Root + 2 Children)' },
      { label: 'Overlap', value: '515s parallel model work' },
      { label: 'Model Calls', value: '200 / 200 completed' },
      { label: 'Cleanup', value: '3/3 archived & deleted' },
    ],
    agents: [
      { id: '/root', role: 'root', color: '#818CF8', turns: 6, calls: 112 },
      { id: '/root/probe_patterns', role: 'child', color: '#34D399', turns: 3, calls: 41 },
      { id: '/root/probe_filters', role: 'child', color: '#F59E0B', turns: 4, calls: 47 },
    ],
    spans: [
      // /root spans
      { id: 's1', agent: '/root', lane: 'input', startSec: 0, endSec: 25, turnId: 't-root-1', label: 'USER initial task' },
      { id: 's2', agent: '/root', lane: 'context', startSec: 25, endSec: 50, turnId: 't-root-1', label: 'CONTEXT workspace & services' },
      { id: 's3', agent: '/root', lane: 'model', startSec: 50, endSec: 120, turnId: 't-root-1', label: 'Plan delegation split' },
      { id: 's4', agent: '/root', lane: 'service', startSec: 120, endSec: 145, turnId: 't-root-1', label: 'spawn_agent ×2' },
      { id: 's5', agent: '/root', lane: 'model', startSec: 165, endSec: 360, turnId: 't-root-2', label: 'Implement CLI core' },
      { id: 's6', agent: '/root', lane: 'tool', startSec: 360, endSec: 520, turnId: 't-root-2', label: 'write & compile core' },
      { id: 's7', agent: '/root', lane: 'input', startSec: 525, endSec: 555, turnId: 't-root-3', label: 'USER mid-flight symlink requirement' },
      { id: 's8', agent: '/root', lane: 'model', startSec: 555, endSec: 650, turnId: 't-root-3', label: 'Route symlink spec to probe_patterns' },
      { id: 's9', agent: '/root', lane: 'service', startSec: 650, endSec: 690, turnId: 't-root-3', label: 'send_message → /root/probe_patterns' },
      { id: 's10', agent: '/root', lane: 'model', startSec: 760, endSec: 1080, turnId: 't-root-4', label: 'Integrate pattern probes' },
      { id: 's11', agent: '/root', lane: 'tool', startSec: 1080, endSec: 1260, turnId: 't-root-4', label: 'bash: pytest symlink suite (16 cases)' },
      { id: 's12', agent: '/root', lane: 'input', startSec: 1320, endSec: 1360, turnId: 't-root-5', label: 'Handoff from /root/probe_filters' },
      { id: 's13', agent: '/root', lane: 'tool', startSec: 1360, endSec: 1580, turnId: 't-root-5', label: 'bash: run 66 filter tests (38 failed)' },
      { id: 's14', agent: '/root', lane: 'model', startSec: 1580, endSec: 2150, turnId: 't-root-5', label: 'Fix filter semantics & edge cases' },
      { id: 's15', agent: '/root', lane: 'tool', startSec: 2150, endSec: 2440, turnId: 't-root-6', label: 'bash: rerun 66/66 filter + 152 total tests' },
      { id: 's16', agent: '/root', lane: 'model', startSec: 2440, endSec: 2634, turnId: 't-root-6', label: 'Finalize archive & summary' },

      // /root/probe_patterns spans
      { id: 'p1', agent: '/root/probe_patterns', lane: 'input', startSec: 128, endSec: 155, turnId: 't-pat-1', label: 'Task from /root (fork_turns: none)' },
      { id: 'p2', agent: '/root/probe_patterns', lane: 'model', startSec: 155, endSec: 340, turnId: 't-pat-1', label: 'Design regex/glob differential probes' },
      { id: 'p3', agent: '/root/probe_patterns', lane: 'tool', startSec: 340, endSec: 590, turnId: 't-pat-1', label: 'bash: probe reference fd 10.3.0' },
      { id: 'p4', agent: '/root/probe_patterns', lane: 'input', startSec: 655, endSec: 680, turnId: 't-pat-2', label: 'steer: symlink & cycle cases' },
      { id: 'p5', agent: '/root/probe_patterns', lane: 'tool', startSec: 680, endSec: 735, turnId: 't-pat-2', label: 'write tests/test_symlinks.py' },
      { id: 'p6', agent: '/root/probe_patterns', lane: 'service', startSec: 735, endSec: 750, turnId: 't-pat-2', label: 'settled → /root' },

      // /root/probe_filters spans
      { id: 'f1', agent: '/root/probe_filters', lane: 'input', startSec: 129, endSec: 158, turnId: 't-flt-1', label: 'Task from /root (shared workspace)' },
      { id: 'f2', agent: '/root/probe_filters', lane: 'model', startSec: 158, endSec: 460, turnId: 't-flt-1', label: 'Audit --extension/--type/--size/--changed' },
      { id: 'f3', agent: '/root/probe_filters', lane: 'tool', startSec: 460, endSec: 920, turnId: 't-flt-1', label: 'write tests/test_filters.py (66 cases)' },
      { id: 'f4', agent: '/root/probe_filters', lane: 'model', startSec: 920, endSec: 1220, turnId: 't-flt-2', label: 'Verify against reference binary' },
      { id: 'f5', agent: '/root/probe_filters', lane: 'service', startSec: 1220, endSec: 1320, turnId: 't-flt-2', label: 'send_message → /root (handoff)' },
    ],
    turns: [
      {
        id: 't-root-1',
        turnNumber: 1,
        agent: '/root',
        role: 'root',
        startSec: 0,
        endSec: 145,
        outcome: 'completed',
        events: [
          {
            id: 'e1',
            kind: 'USER',
            summary: 'Rebuild fd 10.3.0 with build script, documentation, and runnable tests. Delegate independent probe work early.',
            timestamp: '00:00.0',
            payload: { goal: 'sharkdp__fd.40d8eb3', workspace: { id: 'fd-shared', mode: 'read-write' }, maxAgents: 3 },
          },
          {
            id: 'e2',
            kind: 'CONTEXT',
            summary: 'Loaded profile prompt, 4 local tools (read/write/edit/bash), and authorized service: collaboration (6 ops)',
            timestamp: '00:00.4',
            payload: { tools: ['read', 'write', 'edit', 'bash'], services: { collaboration: ['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'interrupt_agent', 'list_agents'] } },
          },
          {
            id: 'e3',
            kind: 'ASSISTANT',
            summary: 'Split work into two independent probes (pattern matching vs filter flags) and keep CLI skeleton & walker in /root.',
            timestamp: '01:58.2',
            tokens: '2.4k out',
          },
          {
            id: 'e4',
            kind: 'SERVICE',
            summary: 'collaboration.spawn_agent {"task_name":"probe_patterns","fork_turns":"none"} → /root/probe_patterns',
            timestamp: '02:08.5',
            durationMs: 4120,
            handoffTo: '/root/probe_patterns',
            payload: {
              service: 'collaboration',
              operation: 'spawn_agent',
              caller: { agentId: 'root-85da', role: 'root' },
              input: { task_name: 'probe_patterns', fork_turns: 'none', message: 'Probe regex/glob matching and path display against reference fd 10.3.0.' },
              result: { task_name: '/root/probe_patterns', status: 'accepted', disposition: 'started' },
            },
          },
          {
            id: 'e5',
            kind: 'SERVICE',
            summary: 'collaboration.spawn_agent {"task_name":"probe_filters","fork_turns":"none"} → /root/probe_filters',
            timestamp: '02:08.6',
            durationMs: 3980,
            handoffTo: '/root/probe_filters',
            payload: {
              service: 'collaboration',
              operation: 'spawn_agent',
              caller: { agentId: 'root-85da', role: 'root' },
              input: { task_name: 'probe_filters', fork_turns: 'none', message: 'Author comprehensive differential filter tests in tests/test_filters.py and notify /root when usable.' },
              result: { task_name: '/root/probe_filters', status: 'accepted', disposition: 'started' },
            },
          },
        ],
      },
      {
        id: 't-pat-1',
        turnNumber: 1,
        agent: '/root/probe_patterns',
        role: 'child',
        startSec: 128,
        endSec: 590,
        outcome: 'completed',
        events: [
          {
            id: 'e6',
            kind: 'USER',
            summary: 'Probe regex/glob matching and path display against reference fd 10.3.0.',
            timestamp: '02:08.6',
            handoffFrom: '/root',
          },
          {
            id: 'e7',
            kind: 'TOOL',
            summary: 'bash {"command":"/opt/ref/fd --version && /opt/ref/fd --help"} → fd 10.3.0',
            timestamp: '05:42.1',
            durationMs: 180,
          },
          {
            id: 'e8',
            kind: 'ASSISTANT',
            summary: 'Cataloged smart-case, full-path (-p), and glob (-g) matching behaviors against reference binary.',
            timestamp: '09:48.0',
            tokens: '3.1k out',
          },
        ],
      },
      {
        id: 't-root-3',
        turnNumber: 3,
        agent: '/root',
        role: 'root',
        startSec: 525,
        endSec: 690,
        outcome: 'completed',
        events: [
          {
            id: 'e9',
            kind: 'USER',
            summary: 'Mid-flight supplement (queued at 03:04): Add explicit tests covering default symlink behavior, -L following links, and directory symlink cycles.',
            timestamp: '09:00.7',
            payload: { requestId: 'user-supplement-1', mode: 'steer', wakeIfIdle: true },
          },
          {
            id: 'e10',
            kind: 'SERVICE',
            summary: 'collaboration.send_message {"target":"/root/probe_patterns","message":"Forward symlink & cycle test requirement"}',
            timestamp: '10:52.0',
            durationMs: 42,
            handoffTo: '/root/probe_patterns',
            payload: {
              deliveryMechanism: 'runtime.send(..., { mode: "steer", wakeIfIdle: false })',
              receipt: { status: 'accepted', disposition: 'queued' },
            },
          },
        ],
      },
      {
        id: 't-pat-2',
        turnNumber: 2,
        agent: '/root/probe_patterns',
        role: 'child',
        startSec: 655,
        endSec: 750,
        outcome: 'completed',
        events: [
          {
            id: 'e11',
            kind: 'USER',
            summary: 'Received live steer notice from /root regarding symlink defaults, -L, and cycle detection.',
            timestamp: '10:55.1',
            handoffFrom: '/root',
          },
          {
            id: 'e12',
            kind: 'TOOL',
            summary: 'write {"file_path":"tests/test_symlinks.py"} → 16 test cases (including 4 symlink cycle cases)',
            timestamp: '11:45.0',
            durationMs: 95,
          },
          {
            id: 'e13',
            kind: 'ASSISTANT',
            summary: 'Completed pattern and symlink differential suite (16 cases) in shared workspace.',
            timestamp: '12:25.5',
            handoffTo: '/root',
          },
        ],
      },
      {
        id: 't-flt-2',
        turnNumber: 2,
        agent: '/root/probe_filters',
        role: 'child',
        startSec: 920,
        endSec: 1320,
        outcome: 'completed',
        events: [
          {
            id: 'e14',
            kind: 'TOOL',
            summary: 'edit {"file_path":"tests/test_filters.py"} → 66 filter compatibility tests verified against reference binary',
            timestamp: '18:10.4',
            durationMs: 112,
          },
          {
            id: 'e15',
            kind: 'SERVICE',
            summary: 'collaboration.send_message {"target":"/root","message":"tests/test_filters.py ready (66 cases covering -e, -t, -S, --changed-within)"}',
            timestamp: '21:58.0',
            durationMs: 38,
            handoffTo: '/root',
            payload: { artifact: 'tests/test_filters.py', verifiedSha256Match: true },
          },
        ],
      },
      {
        id: 't-root-5',
        turnNumber: 5,
        agent: '/root',
        role: 'root',
        startSec: 1320,
        endSec: 2150,
        outcome: 'completed',
        events: [
          {
            id: 'e16',
            kind: 'USER',
            summary: 'Handoff notice from /root/probe_filters: tests/test_filters.py is ready in shared workspace.',
            timestamp: '22:01.0',
            handoffFrom: '/root/probe_filters',
          },
          {
            id: 'e17',
            kind: 'TOOL',
            summary: 'bash {"command":"pytest tests/test_filters.py"} → 28 passed, 38 failed',
            timestamp: '23:44.2',
            durationMs: 2410,
          },
          {
            id: 'e18',
            kind: 'TOOL',
            summary: 'edit {"file_path":"src/filters.rs"} → fix size unit parsing, multi-extension matching, and hidden-file interaction',
            timestamp: '34:18.6',
            durationMs: 140,
          },
        ],
      },
      {
        id: 't-root-6',
        turnNumber: 6,
        agent: '/root',
        role: 'root',
        startSec: 2150,
        endSec: 2634,
        outcome: 'completed',
        events: [
          {
            id: 'e19',
            kind: 'TOOL',
            summary: 'bash {"command":"./compile.sh && pytest tests/"} → 66/66 filter tests passed, 152/152 submitted tests passed',
            timestamp: '39:12.0',
            durationMs: 4820,
          },
          {
            id: 'e20',
            kind: 'ASSISTANT',
            summary: 'Delivered buildable fd candidate with compile.sh, README, and 152 tests. Offline cleanroom score: 1,042 / 1,235 (84.37%).',
            timestamp: '43:54.1',
            tokens: '1.8k out',
          },
          {
            id: 'e21',
            kind: 'SYSTEM',
            summary: 'runtime.close() complete · 3/3 Sessions archived · 200 model traces saved · 3/3 sandboxes deleted (HTTP 404)',
            timestamp: '43:55.5',
            payload: { cleanup: 'complete', sessionArchives: 3, modelTraces: 200, pending: [] },
          },
        ],
      },
    ],
  },
  {
    id: 'flat-task-pool',
    title: 'Flat · Exclusive Task Pool & Workspace',
    program: 'flat',
    subtitle: '只读启动发现任务 → 排他认领触发 files.prepare + grant → Model Access Policy 租约保护 → Material 与 Workspace 合入',
    durationSec: 420,
    status: 'ALL TASKS TERMINAL · main @ 0.3',
    metrics: [
      { label: 'Duration', value: '7m 00s' },
      { label: 'Capacity', value: '2 concurrent Slots' },
      { label: 'Tasks', value: '3 / 3 DONE' },
      { label: 'Materials', value: '2 published & consumed' },
      { label: 'Workspace', value: 'main advanced 0.1 → 0.3' },
    ],
    agents: [
      { id: 'researcher-1', role: 'researcher', color: '#818CF8', turns: 3, calls: 14 },
      { id: 'researcher-2', role: 'researcher', color: '#2DD4BF', turns: 2, calls: 11 },
    ],
    spans: [
      { id: 'fl1', agent: 'researcher-1', lane: 'input', startSec: 0, endSec: 15, turnId: 't-fl-1', label: 'Read-only discovery prompt' },
      { id: 'fl2', agent: 'researcher-1', lane: 'service', startSec: 15, endSec: 55, turnId: 't-fl-1', label: 'task.list & task.take T1' },
      { id: 'fl3', agent: 'researcher-1', lane: 'context', startSec: 55, endSec: 80, turnId: 't-fl-1', label: 'Host: files.prepare + files.grant' },
      { id: 'fl4', agent: 'researcher-1', lane: 'model', startSec: 80, endSec: 170, turnId: 't-fl-2', label: 'Implement parser module' },
      { id: 'fl5', agent: 'researcher-1', lane: 'tool', startSec: 170, endSec: 215, turnId: 't-fl-2', label: 'write & test parser.ts' },
      { id: 'fl6', agent: 'researcher-1', lane: 'service', startSec: 215, endSec: 255, turnId: 't-fl-2', label: 'material.publish + workspace.merge + task.finish' },

      { id: 'fl7', agent: 'researcher-2', lane: 'input', startSec: 10, endSec: 25, turnId: 't-fl-3', label: 'Read-only discovery prompt' },
      { id: 'fl8', agent: 'researcher-2', lane: 'service', startSec: 25, endSec: 65, turnId: 't-fl-3', label: 'task.take T1 (CONFLICT) → take T2' },
      { id: 'fl9', agent: 'researcher-2', lane: 'model', startSec: 85, endSec: 230, turnId: 't-fl-3', label: 'Implement formatter module' },
      { id: 'fl10', agent: 'researcher-2', lane: 'service', startSec: 265, endSec: 320, turnId: 't-fl-4', label: 'material.consume M1 + workspace.save + merge' },
      { id: 'fl11', agent: 'researcher-2', lane: 'service', startSec: 320, endSec: 410, turnId: 't-fl-4', label: 'task.finish T2 → main @ 0.3' },
    ],
    turns: [
      {
        id: 't-fl-1',
        turnNumber: 1,
        agent: 'researcher-1',
        role: 'researcher',
        startSec: 0,
        endSec: 80,
        outcome: 'completed',
        events: [
          {
            id: 'fe1',
            kind: 'CONTEXT',
            summary: 'Spawned with writable: false. ModelAccessPolicy enforces phase="selection" deadline.',
            timestamp: '00:00.0',
          },
          {
            id: 'fe2',
            kind: 'SERVICE',
            summary: 'task.take {"task_id":"T1"} → Execution E1 created (fencing_version: 1)',
            timestamp: '00:38.2',
            durationMs: 1850,
            payload: { execution_id: 'exec-1', fencing_version: 1, workspace_input: '0.1' },
          },
          {
            id: 'fe3',
            kind: 'SYSTEM',
            summary: 'Host handoff: runtime.files.prepare(0.1) → start_execution → runtime.files.grant(writable: true)',
            timestamp: '01:12.4',
            payload: { preparedVersion: 1, writable: true, modelPermitPhase: 'work' },
          },
        ],
      },
      {
        id: 't-fl-3',
        turnNumber: 1,
        agent: 'researcher-2',
        role: 'researcher',
        startSec: 10,
        endSec: 230,
        outcome: 'completed',
        events: [
          {
            id: 'fe4',
            kind: 'SERVICE',
            summary: 'task.take {"task_id":"T1"} → CONFLICT (already owned by researcher-1); falls back to task.take T2',
            timestamp: '00:44.0',
            durationMs: 24,
            payload: { firstAttempt: 'CONFLICT', secondAttempt: { task_id: 'T2', execution_id: 'exec-2', fencing_version: 1 } },
          },
          {
            id: 'fe5',
            kind: 'ASSISTANT',
            summary: 'Claimed T2 (formatter). Received read-write Workspace snapshot 0.1 and implemented color output rules.',
            timestamp: '03:45.0',
          },
        ],
      },
      {
        id: 't-fl-2',
        turnNumber: 2,
        agent: 'researcher-1',
        role: 'researcher',
        startSec: 80,
        endSec: 255,
        outcome: 'completed',
        events: [
          {
            id: 'fe6',
            kind: 'SERVICE',
            summary: 'material.publish → M1 ("Color parser grammar & edge cases")',
            timestamp: '03:38.0',
            handoffTo: 'researcher-2',
          },
          {
            id: 'fe7',
            kind: 'SERVICE',
            summary: 'workspace.save (rev 0.2) → workspace.merge (main: 0.2) → task.finish T1 (done)',
            timestamp: '04:14.2',
          },
        ],
      },
      {
        id: 't-fl-4',
        turnNumber: 2,
        agent: 'researcher-2',
        role: 'researcher',
        startSec: 265,
        endSec: 410,
        outcome: 'completed',
        events: [
          {
            id: 'fe8',
            kind: 'SERVICE',
            summary: 'material.consume {"material_ids":["M1"],"action":"integration"}',
            timestamp: '04:32.0',
            handoffFrom: 'researcher-1',
          },
          {
            id: 'fe9',
            kind: 'SERVICE',
            summary: 'workspace.save (rev 0.3) → workspace.merge (main: 0.3) → task.finish T2 (done)',
            timestamp: '06:48.0',
          },
        ],
      },
    ],
  },
  {
    id: 'agensh-peer-git',
    title: 'Agensh · Peer Negotiation & Git PR',
    program: 'agensh',
    subtitle: 'Board 软意向 CLAIM 允许重叠 → Mattermost 频道协商分工 → 串行 Router 附带最新 Board 视图投递 → 独立分支提 PR 由宿主合入',
    durationSec: 360,
    status: 'PR #1 & #2 MERGED · CLEANUP COMPLETE',
    metrics: [
      { label: 'Duration', value: '6m 00s' },
      { label: 'Peers', value: '2 (peer-a, peer-b)' },
      { label: 'Board Notes', value: '5 (CLAIM / FACT / PATCH_SUMMARY)' },
      { label: 'PRs Merged', value: '2 / 2 verified on main' },
    ],
    agents: [
      { id: 'peer-a', role: 'peer-a', color: '#60A5FA', turns: 2, calls: 9 },
      { id: 'peer-b', role: 'peer-b', color: '#F472B6', turns: 2, calls: 8 },
    ],
    spans: [
      { id: 'ag1', agent: 'peer-a', lane: 'input', startSec: 0, endSec: 20, turnId: 't-ag-1', label: 'Router batch: kickoff + Board view' },
      { id: 'ag2', agent: 'peer-a', lane: 'service', startSec: 20, endSec: 70, turnId: 't-ag-1', label: 'board_write CLAIM + post_message' },
      { id: 'ag3', agent: 'peer-a', lane: 'tool', startSec: 120, endSec: 260, turnId: 't-ag-2', label: 'git commit & push peer-a + PR #1' },
      { id: 'ag4', agent: 'peer-b', lane: 'input', startSec: 10, endSec: 35, turnId: 't-ag-3', label: 'Router batch: kickoff + Board view' },
      { id: 'ag5', agent: 'peer-b', lane: 'service', startSec: 35, endSec: 95, turnId: 't-ag-3', label: 'Overlapping CLAIM → reply in channel' },
      { id: 'ag6', agent: 'peer-b', lane: 'tool', startSec: 130, endSec: 310, turnId: 't-ag-4', label: 'git commit & push peer-b + PR #2' },
    ],
    turns: [
      {
        id: 't-ag-1',
        turnNumber: 1,
        agent: 'peer-a',
        role: 'peer-a',
        startSec: 0,
        endSec: 90,
        outcome: 'completed',
        events: [
          {
            id: 'ae1',
            kind: 'SERVICE',
            summary: 'agensh-context.board_write {"type":"CLAIM","content":"Planning to refactor CLI flag parser"}',
            timestamp: '00:28.0',
          },
          {
            id: 'ae2',
            kind: 'SERVICE',
            summary: 'message.post_message {"message":"@peer-b Saw your overlapping claim — I will take parser, can you own output formatting?"}',
            timestamp: '01:02.0',
            handoffTo: 'peer-b',
          },
        ],
      },
      {
        id: 't-ag-3',
        turnNumber: 1,
        agent: 'peer-b',
        role: 'peer-b',
        startSec: 10,
        endSec: 115,
        outcome: 'completed',
        events: [
          {
            id: 'ae3',
            kind: 'USER',
            summary: 'Router delivered Mattermost mention from peer-a along with fresh Board snapshot (mode: followUp).',
            timestamp: '01:08.4',
            handoffFrom: 'peer-a',
          },
          {
            id: 'ae4',
            kind: 'SERVICE',
            summary: 'message.post_message {"message":"Agreed. Switching branch peer-b to output formatting and tests."}',
            timestamp: '01:42.0',
            handoffTo: 'peer-a',
          },
        ],
      },
      {
        id: 't-ag-2',
        turnNumber: 2,
        agent: 'peer-a',
        role: 'peer-a',
        startSec: 120,
        endSec: 260,
        outcome: 'completed',
        events: [
          {
            id: 'ae5',
            kind: 'TOOL',
            summary: 'bash {"command":"git add -A && git commit -m \'parser\' && git push origin peer-a"}',
            timestamp: '03:50.0',
          },
          {
            id: 'ae6',
            kind: 'SERVICE',
            summary: 'gitea.pull_request_write {"head":"peer-a","base":"main"} → PR #1 · board_write PATCH_SUMMARY',
            timestamp: '04:15.0',
          },
        ],
      },
      {
        id: 't-ag-4',
        turnNumber: 2,
        agent: 'peer-b',
        role: 'peer-b',
        startSec: 130,
        endSec: 340,
        outcome: 'completed',
        events: [
          {
            id: 'ae7',
            kind: 'SERVICE',
            summary: 'gitea.pull_request_write {"head":"peer-b","base":"main"} → PR #2',
            timestamp: '05:05.0',
          },
          {
            id: 'ae8',
            kind: 'SYSTEM',
            summary: 'Host createAgenshDelivery verified head commits & merged PR #1 and PR #2 into main.',
            timestamp: '05:54.0',
          },
        ],
      },
    ],
  },
];
