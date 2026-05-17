package anonymous

import "github.com/docker/docker/api/types/filters"

func jumpserverFilter() filters.Args {
	a := filters.NewArgs()
	a.Add("label", "jumpserver.kind=anonymous")
	return a
}
