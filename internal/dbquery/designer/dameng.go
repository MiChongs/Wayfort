package designer

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

type damengDesigner struct{}

// NewDameng returns a Designer that renders Dameng/Oracle-flavored DDL.
// Phase 3B.1 ships Table; the rest return errNotYetImplemented.
func NewDameng() Designer { return &damengDesigner{} }

func (d *damengDesigner) RenderTable(ctx context.Context, spec TableSpec) (string, error) {
	if spec.Name == "" {
		return "", errors.New("designer: TableSpec.Name required")
	}
	lines := make([]string, 0, len(spec.Columns)+1)
	for _, c := range spec.Columns {
		var lb strings.Builder
		fmt.Fprintf(&lb, "  %s %s", dmIdent(strings.ToUpper(c.Name)), dmMapType(c.DataType))
		if !c.Nullable {
			lb.WriteString(" NOT NULL")
		}
		lines = append(lines, lb.String())
	}
	if len(spec.PrimaryKey) > 0 {
		upper := make([]string, len(spec.PrimaryKey))
		for i, k := range spec.PrimaryKey {
			upper[i] = strings.ToUpper(k)
		}
		lines = append(lines, fmt.Sprintf("  PRIMARY KEY (%s)", dmIdents(upper)))
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s (\n", dmQualify(spec.Schema, spec.Name))
	b.WriteString(strings.Join(lines, ",\n"))
	b.WriteString("\n)")
	return b.String(), nil
}

// Stubs for the other 7 object kinds.
func (d *damengDesigner) RenderView(ctx context.Context, s ViewSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *damengDesigner) RenderFunction(ctx context.Context, s FunctionSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *damengDesigner) RenderProcedure(ctx context.Context, s ProcedureSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *damengDesigner) RenderTrigger(ctx context.Context, s TriggerSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *damengDesigner) RenderEvent(ctx context.Context, s EventSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *damengDesigner) RenderIndex(ctx context.Context, s IndexSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *damengDesigner) RenderSequence(ctx context.Context, s SequenceSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *damengDesigner) Diff(ctx context.Context, oldSpec, newSpec any) ([]Change, error) {
	return nil, errNotYetImplemented
}

// ----- helpers -----

// dmMapType maps generic SQL types to Dameng/Oracle equivalents.
func dmMapType(s string) string {
	switch strings.ToUpper(s) {
	case "BIGINT":
		return "NUMBER(19)"
	case "VARCHAR", "VARCHAR(255)":
		return "VARCHAR2(255)"
	case "TIMESTAMP":
		return "TIMESTAMP"
	case "INTEGER", "INT":
		return "NUMBER(10)"
	case "TEXT":
		return "CLOB"
	case "BYTEA", "BLOB":
		return "BLOB"
	}
	return s
}

func dmIdent(s string) string { return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\"" }

func dmIdents(ss []string) string {
	parts := make([]string, len(ss))
	for i, s := range ss {
		parts[i] = dmIdent(s)
	}
	return strings.Join(parts, ", ")
}

func dmQualify(schema, name string) string {
	if schema == "" {
		return dmIdent(strings.ToUpper(name))
	}
	return dmIdent(strings.ToUpper(schema)) + "." + dmIdent(strings.ToUpper(name))
}
