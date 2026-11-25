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
}

export interface TraceEvent {
  id: string;
  kind: EventKind;
  summary: string;
  timestamp: string;
  durationMs?: number;
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
  outcome: string;
  events: TraceEvent[];
}

export interface RunTrace {
  id: string;
  title: string;
  isLocal: boolean;
  subtitle: string;
  durationSec: number;
  metrics: { label: string; value: string }[];
  agents: { id: string; role: string; color: string; turns: number; calls: number }[];
  spans: TimelineSpan[];
  turns: TraceTurn[];
}

/**
 * Minimal structural sample used ONLY when the user explicitly clicks
 * "Load layout preview" to inspect how a loaded local Run directory renders.
 * Never presented as a real production log.
 */
export const LAYOUT_PREVIEW_TRACE: RunTrace = {
  id: 'layout-preview',
  title: '结构示意样例（非真实日志）',
  isLocal: false,
  subtitle: '仅用于展示载入本地 outputDir/<runId>/ 后的泳道与事件结构；请点击「选择本地 Run 目录」查看真实记录。',
  durationSec: 180,
  metrics: [
    { label: '数据来源', value: '结构示意' },
    { label: 'Agents', value: '3' },
    { label: '示意事件', value: '8' },
  ],
  agents: [
    { id: '/root', role: 'root', color: '#2c4cde', turns: 2, calls: 4 },
    { id: '/root/probe_patterns', role: 'child', color: '#0f766e', turns: 1, calls: 2 },
    { id: '/root/probe_filters', role: 'child', color: '#c26d0a', turns: 1, calls: 2 },
  ],
  spans: [
    { id: 'sp-1', agent: '/root', lane: 'input', startSec: 0, endSec: 12, turnId: 'turn-root-1', label: 'USER task' },
    { id: 'sp-2', agent: '/root', lane: 'model', startSec: 12, endSec: 34, turnId: 'turn-root-1', label: '拆分并委派子任务' },
    { id: 'sp-3', agent: '/root', lane: 'service', startSec: 34, endSec: 46, turnId: 'turn-root-1', label: 'collaboration.spawn_agent' },
    { id: 'sp-4', agent: '/root/probe_patterns', lane: 'tool', startSec: 48, endSec: 108, turnId: 'turn-pat-1', label: '并行探测模式边界' },
    { id: 'sp-5', agent: '/root/probe_patterns', lane: 'service', startSec: 108, endSec: 118, turnId: 'turn-pat-1', label: 'settled → /root' },
    { id: 'sp-6', agent: '/root/probe_filters', lane: 'tool', startSec: 50, endSec: 126, turnId: 'turn-flt-1', label: '编写过滤回归测试' },
    { id: 'sp-7', agent: '/root/probe_filters', lane: 'service', startSec: 126, endSec: 136, turnId: 'turn-flt-1', label: 'send_message → /root' },
    { id: 'sp-8', agent: '/root', lane: 'model', startSec: 138, endSec: 180, turnId: 'turn-root-2', label: '整合测试并验证收尾' },
  ],
  turns: [
    {
      id: 'turn-root-1',
      turnNumber: 1,
      agent: '/root',
      role: 'root',
      startSec: 0,
      endSec: 46,
      outcome: 'completed',
      events: [
        {
          id: 'ev-1',
          kind: 'USER',
          summary: '将需求拆分为模式探测与过滤测试两条并行分支，完成后整合回归。',
          timestamp: '00:00',
          payload: { mode: 'followUp', wakeIfIdle: true },
        },
        {
          id: 'ev-2',
          kind: 'SERVICE',
          summary: 'collaboration.spawn_agent 创建 /root/probe_patterns 与 /root/probe_filters',
          timestamp: '00:34',
          handoffTo: '/root/probe_patterns, /root/probe_filters',
          payload: {
            service: 'collaboration',
            operation: 'spawn_agent',
            children: ['/root/probe_patterns', '/root/probe_filters'],
          },
        },
      ],
    },
    {
      id: 'turn-pat-1',
      turnNumber: 1,
      agent: '/root/probe_patterns',
      role: 'child',
      startSec: 48,
      endSec: 118,
      outcome: 'completed',
      events: [
        {
          id: 'ev-3',
          kind: 'TOOL',
          summary: '执行差分脚本并写入模式与符号链接边界测试',
          timestamp: '00:52',
          payload: { tool: 'bash', path: 'tests/test_patterns.py' },
        },
        {
          id: 'ev-4',
          kind: 'SYSTEM',
          summary: 'settled (completed) — 结果通过事件回传直属父节点',
          timestamp: '01:58',
          handoffTo: '/root',
          payload: { type: 'settled', outcome: 'completed' },
        },
      ],
    },
    {
      id: 'turn-flt-1',
      turnNumber: 1,
      agent: '/root/probe_filters',
      role: 'child',
      startSec: 50,
      endSec: 136,
      outcome: 'completed',
      events: [
        {
          id: 'ev-5',
          kind: 'TOOL',
          summary: '编写过滤参数组合回归测试套件',
          timestamp: '01:05',
          payload: { tool: 'write', path: 'tests/test_filters.py' },
        },
        {
          id: 'ev-6',
          kind: 'SERVICE',
          summary: 'collaboration.send_message 通知 /root 验收测试文件',
          timestamp: '02:06',
          handoffTo: '/root',
          payload: { service: 'collaboration', operation: 'send_message', target: '/root' },
        },
      ],
    },
    {
      id: 'turn-root-2',
      turnNumber: 2,
      agent: '/root',
      role: 'root',
      startSec: 138,
      endSec: 180,
      outcome: 'completed',
      events: [
        {
          id: 'ev-7',
          kind: 'ASSISTANT',
          summary: '运行子成员交付的测试套件，修复失败用例并确认通过。',
          timestamp: '02:24',
          handoffFrom: '/root/probe_filters',
        },
        {
          id: 'ev-8',
          kind: 'SYSTEM',
          summary: 'runtime.close() — 会话归档、文件导出与沙箱回收完成',
          timestamp: '03:00',
          payload: { execution: 'stopped', cleanup: 'complete' },
        },
      ],
    },
  ],
};
