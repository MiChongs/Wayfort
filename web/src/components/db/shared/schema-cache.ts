import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { dbService } from "@/lib/api/services";

/** Cache key shape: ["schema-snapshot", nodeId, database]. Empty database
 *  collapses to "__default__" so the per-node default catalogue snapshot
 *  is cached under a stable key. */
export function schemaCacheKey(nodeId: number, database: string): [string, number, string] {
  return ["schema-snapshot", nodeId, database || "__default__"];
}

export interface SchemaSnapshot {
  database: string;
  schemas: string[];
  tables: Array<{
    schema: string;
    name: string;
    kind: string;
    columns: Array<{ name: string; dataType: string; nullable: boolean }>;
  }>;
  functions: Array<{
    schema: string;
    name: string;
    argTypes: string[];
    returnType: string;
  }>;
  updatedAt: number;
}

/** TTL: 5 minutes; DDL change events invalidate (handled at sub-project A). */
const STALE_MS = 5 * 60 * 1000;

export function useSchemaSnapshot(
  nodeId: number,
  database: string,
  options?: Omit<UseQueryOptions<SchemaSnapshot>, "queryKey" | "queryFn">,
) {
  return useQuery<SchemaSnapshot>({
    queryKey: schemaCacheKey(nodeId, database),
    queryFn: () => dbService.completionSnapshot(nodeId, database) as Promise<SchemaSnapshot>,
    staleTime: STALE_MS,
    enabled: !!nodeId,
    ...options,
  });
}
