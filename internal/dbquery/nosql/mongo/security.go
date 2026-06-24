package mongo

// IsForbiddenPipeline reports whether the aggregation pipeline contains a
// stage that the default security policy rejects.
//
// The default policy forbids stages that persist the pipeline's output to a
// destination other than the source collection — namely $out and $merge —
// because they turn a read-only aggregation into a write against an arbitrary
// collection, which the Db Studio query surface (currently a read/discovery
// tool) must not allow. The guard is intentionally cheap and side-effect-free:
// it inspects only the stage-operator key of each stage (every well-formed
// aggregation stage is a single-key document whose key is the operator).
//
// A per-node policy override hook is a Phase 3D.9 follow-up; until then this
// is the single, non-configurable gate applied by Adapter.Aggregate.
func IsForbiddenPipeline(stages []map[string]any) bool {
	for _, stage := range stages {
		for key := range stage {
			switch key {
			case "$out", "$merge":
				return true
			}
		}
	}
	return false
}
