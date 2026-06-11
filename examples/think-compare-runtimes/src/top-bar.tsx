import { Button } from "@cloudflare/kumo/components/button";
import { comparisonFixture } from "../shared/fixture";

export interface TopBarProps {
  actionLabel: string;
  disabled: boolean;
  error: string | null;
  onStart: () => void;
  runId: string | null;
  runLabel: string;
}

export function TopBar({ actionLabel, disabled, error, onStart, runId, runLabel }: TopBarProps) {
  return (
    <header className="flex min-h-[67px] flex-wrap items-center justify-between gap-4 border-[#22272E] border-b bg-[#0E1013] px-8 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-8">
        <div className="flex shrink-0 items-center gap-3 border-[#22272E] border-r pr-8">
          <span className="grid size-5 place-items-center rounded-[0.35rem] border-2 border-[#F2A93B] text-[#F2A93B]">
            <span className="size-2 rounded-[0.15rem] bg-[#F2A93B]" />
          </span>
          <span className="font-mono text-sm font-semibold tracking-[0.22em] text-[#E6E8EA] uppercase">
            THINK · RUNTIME COMPARE
          </span>
        </div>

        <div className="min-w-[18rem] flex-1">
          <p className="font-mono text-[0.68rem] tracking-[0.2em] text-[#8A9099] uppercase">
            TASK <span className="tracking-[0.12em]">{comparisonFixture.files.length} files</span>
          </p>
          <p className="mt-1 truncate text-sm text-[#E6E8EA]">{comparisonFixture.task}</p>
          {error ? <p className="mt-1 text-xs text-[#E15B5B]">{error}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-5">
        <StatusReadout label={runLabel} />
        {runId ? (
          <code className="font-mono text-xs text-[#8A9099]">{runId}</code>
        ) : (
          <span className="font-mono text-xs text-[#8A9099]">ready</span>
        )}
        <Button
          className="h-[38px] rounded-[0.18rem] border border-[#F2A93B] bg-[#F2A93B] px-7 font-mono text-xs font-semibold tracking-[0.24em] !text-[#0E1013] uppercase hover:bg-[#ffc46d] disabled:border-[#3A4048] disabled:bg-[#171A1F] disabled:!text-[#8A9099]"
          disabled={disabled}
          onClick={onStart}
          type="button"
          variant="primary"
        >
          {disabled ? "STARTING" : actionLabel}
        </Button>
      </div>
    </header>
  );
}

function StatusReadout({ label }: { label: string }) {
  const done = label.startsWith("DONE");
  const run = label.startsWith("RUN");
  const tone = done ? "text-[#5BC8A7]" : run ? "text-[#F2A93B]" : "text-[#8A9099]";

  return (
    <span className="border border-[#22272E] bg-[#171A1F] px-4 py-2 font-mono text-xs tracking-[0.18em] uppercase">
      <span className={tone}>●</span> {label}
    </span>
  );
}
