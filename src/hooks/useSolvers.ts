import useSWR from "swr";
import { endpoint } from "@/lib/api";
import { solverListSchema } from "@/lib/schemas";

const fetcher = endpoint(solverListSchema);
import type { Solver } from "@/lib/types";

// The solver list has no WebSocket coverage; it changes slowly (new
// registrations, bond updates) rather than second-by-second. A 30 s poll
// keeps the leaderboard reasonably fresh without hammering the relay.
//
// dedupingInterval matches refreshInterval to prevent duplicate requests
// on rapid re-mounts within the same 30 s window.
export function useSolvers() {
  const { data, error, isLoading } = useSWR<Solver[]>("/solvers", fetcher, {
    refreshInterval: 30_000,
    dedupingInterval: 30_000,
  });

  return { solvers: data ?? [], isLoading, error };
}
