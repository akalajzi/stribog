import type { NetworkPayload } from "../api.ts";

// Placeholder; replaced by the full view.
export function PlanView({ data }: { data: NetworkPayload }) {
  return <div className="scroll"><div className="page"><h1>Plan</h1><p className="lede">{data.model.site}</p></div></div>;
}
