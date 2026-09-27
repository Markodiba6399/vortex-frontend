import useSWR from "swr";
import { endpoint } from "@/lib/api";
import { intentDetailSchema } from "@/lib/schemas";

const fetcher = endpoint(intentDetailSchema);
import type { IntentDetail } from "@/lib/types";

// Single-intent detail fetch. No WebSocket or polling needed — the user
// navigates here to check a specific intent's outcome.
//
// revalidateOnFocus: true (default) is kept because a user may tab away,
// wait for a fill, and tab back — which should show the updated status.
//
// dedupingInterval: 5 s prevents rapid focus events from firing duplicate
// requests during the short window after the initial load.
export function useIntent(id: string | null) {
  const { data, error, isLoading } = useSWR<IntentDetail>(
    id ? `/intents/${id}` : null,
    fetcher,
    {
      refreshInterval: 0,
      dedupingInterval: 5_000,
      revalidateOnFocus: true,
    },
  );

  return { intent: data, isLoading, error };
}
