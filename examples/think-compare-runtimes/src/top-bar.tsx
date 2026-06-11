import { Button } from "@cloudflare/kumo/components/button";

export interface TopBarProps {
  actionLabel: string;
  disabled: boolean;
  error: string | null;
  onStart: () => void;
  runId: string | null;
  runLabel: string;
}

export function TopBar({ actionLabel, disabled, error, onStart }: TopBarProps) {
  return (
    <header className="shrink-0 border-[#DED8CD] border-b bg-[#FBFAF6]">
      <div className="flex items-center justify-between gap-4 px-6 py-3">
        <div className="min-w-0 flex items-baseline gap-4">
          <h1 className="font-semibold text-2xl tracking-[-0.07em] text-[#111111]">
            Workspace / Sandbox
          </h1>
          {error ? <span className="truncate text-sm text-[#B42318]">{error}</span> : null}
        </div>

        <Button
          className="h-10 !w-36 shrink-0 justify-center rounded-[0.2rem] border border-[#111111] bg-[#111111] px-4 text-center font-mono text-xs font-semibold tracking-[0.16em] !text-white uppercase hover:bg-[#2A2927] disabled:border-[#D8D2C8] disabled:bg-[#EEEAE2] disabled:!text-[#A9A49B]"
          disabled={disabled}
          onClick={onStart}
          type="button"
          variant="primary"
        >
          {actionLabel}
        </Button>
      </div>
    </header>
  );
}
