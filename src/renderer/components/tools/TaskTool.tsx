import type { AgentInput, SubagentToolCall, ToolUseSimple } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { ToolHeader } from './utils';

interface TaskToolProps {
  tool: ToolUseSimple;
}

export default function TaskTool({ tool }: TaskToolProps) {
  const input = tool.parsedInput as AgentInput;

  if (!input) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader tool={tool} toolName={tool.name} />
      <span className="rounded border border-purple-200/50 bg-purple-50/50 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:border-purple-500/30 dark:bg-purple-500/10 dark:text-purple-300">
        {input.subagent_type}
      </span>
      {input.model && (
        <span className="rounded border border-blue-200/50 bg-blue-50/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
          {input.model}
        </span>
      )}
    </div>
  );

  const renderSubagentCall = (call: SubagentToolCall) => {
    const description =
      (
        call.parsedInput &&
        typeof call.parsedInput === 'object' &&
        'description' in call.parsedInput
      ) ?
        String(call.parsedInput.description ?? '')
      : typeof call.input === 'object' && call.input && 'description' in call.input ?
        String(call.input.description ?? '')
      : '';
    const inputText =
      call.inputJson ?? (call.input ? JSON.stringify(call.input, null, 2) : undefined);
    const isRunning = call.isLoading && !call.result;

    return (
      <div key={call.id} className="rounded border border-neutral-200/70 bg-white/70 p-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-neutral-700">
          <span>{call.name}</span>
          {isRunning && <span className="text-[10px] text-neutral-400">running</span>}
        </div>
        {description && <div className="mt-1 text-xs text-neutral-500">{description}</div>}
        {inputText && (
          <pre className="mt-2 overflow-x-auto rounded bg-neutral-100/50 px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap text-neutral-600">
            {inputText}
          </pre>
        )}
        {call.result && (
          <pre className="mt-2 overflow-x-auto rounded bg-neutral-100/50 px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap text-neutral-600">
            {call.result}
          </pre>
        )}
      </div>
    );
  };

  const expandedContent = (
    <div className="space-y-2">
      {input.prompt && (
        <pre className="overflow-x-auto rounded bg-neutral-100/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-neutral-600 dark:bg-neutral-950/50 dark:text-neutral-300">
          {input.prompt}
        </pre>
      )}

      {tool.subagentCalls && tool.subagentCalls.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-neutral-500">Subagent tool calls</div>
          <div className="space-y-2">{tool.subagentCalls.map(renderSubagentCall)}</div>
        </div>
      )}

      {tool.result && (
        <pre className="overflow-x-auto rounded bg-neutral-100/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-neutral-600 dark:bg-neutral-950/50 dark:text-neutral-300">
          {tool.result}
        </pre>
      )}
    </div>
  );

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
