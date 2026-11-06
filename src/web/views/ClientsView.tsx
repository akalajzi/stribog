import type { NetworkPayload } from "../api.ts";

// Placeholder; replaced by the full view.
export function ClientsView({ data }: { data: NetworkPayload; onSelect: (id: string) => void }) {
  return <div className="scroll"><div className="page"><h1>ClientsView</h1><p className="lede">{data.model.site}</p></div></div>;
}
