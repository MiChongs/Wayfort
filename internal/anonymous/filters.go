package anonymous

import "github.com/docker/docker/api/types/filters"

func wayfortFilter() filters.Args {
	a := filters.NewArgs()
	a.Add("label", "wayfort.kind=anonymous")
	return a
}
