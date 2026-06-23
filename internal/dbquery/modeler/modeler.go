// Package modeler bridges ER models <-> live database schemas.
// Reverse: introspect DB -> Model. Forward: Model -> DDL. Diff: Model <-> DB.
package modeler

import (
	"context"

	"github.com/michongs/wayfort/internal/dbquery/designer"
)

type Modeler interface {
	// Reverse builds a model snapshot from a live schema.
	Reverse(ctx context.Context, schemas []string) (Model, error)
	// Forward renders DDL for a model using the adapter's Designer.
	Forward(ctx context.Context, model Model) ([]string, error)
	// Diff compares an in-memory model with the live schema and
	// returns symmetric changes (model-only / both-differ / db-only).
	Diff(ctx context.Context, model Model) (DiffResult, error)
}

type Model struct {
	Dialect   string
	Tables    []designer.TableSpec
	Relations []Relation
	Layout    Layout
}

type Relation struct {
	Name string
	From RelationEnd
	To   RelationEnd
}

type RelationEnd struct {
	Schema  string
	Table   string
	Columns []string
}

type Layout struct {
	Positions map[string]Point // table FQN -> (x,y)
	Sizes     map[string]Size
}

type Point struct{ X, Y float64 }
type Size struct{ Width, Height float64 }

type DiffResult struct {
	OnlyInModel []designer.Change
	Differing   []designer.Change
	OnlyInDB    []designer.Change
}
