package designer

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

type postgresDesigner struct{}

// NewPostgres returns a Designer that renders PostgreSQL-flavored DDL.
// Phase 3B.1 ships Table; the rest return errNotYetImplemented.
func NewPostgres() Designer { return &postgresDesigner{} }

func (d *postgresDesigner) RenderTable(ctx context.Context, spec TableSpec) (string, error) {
	if spec.Name == "" {
		return "", errors.New("designer: TableSpec.Name required")
	}
	lines := make([]string, 0, len(spec.Columns)+1)
	for _, c := range spec.Columns {
		var lb strings.Builder
		fmt.Fprintf(&lb, "  %s %s", pgIdent(c.Name), c.DataType)
		if !c.Nullable {
			lb.WriteString(" NOT NULL")
		}
		if c.AutoIncrement {
			lb.WriteString(" GENERATED ALWAYS AS IDENTITY")
		} else if c.Default != nil {
			fmt.Fprintf(&lb, " DEFAULT %s", pgLiteral(*c.Default))
		}
		lines = append(lines, lb.String())
	}
	if len(spec.PrimaryKey) > 0 {
		lines = append(lines, fmt.Sprintf("  PRIMARY KEY (%s)", pgIdents(spec.PrimaryKey)))
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s (\n", pgQualify(spec.Schema, spec.Name))
	b.WriteString(strings.Join(lines, ",\n"))
	b.WriteString("\n)")
	return b.String(), nil
}

// Stubs for the other 7 object kinds — same pattern as mysql.go.
func (d *postgresDesigner) RenderView(ctx context.Context, s ViewSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *postgresDesigner) RenderFunction(ctx context.Context, s FunctionSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *postgresDesigner) RenderProcedure(ctx context.Context, s ProcedureSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *postgresDesigner) RenderTrigger(ctx context.Context, s TriggerSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *postgresDesigner) RenderEvent(ctx context.Context, s EventSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *postgresDesigner) RenderIndex(ctx context.Context, s IndexSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *postgresDesigner) RenderSequence(ctx context.Context, s SequenceSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *postgresDesigner) Diff(ctx context.Context, oldSpec, newSpec any) ([]Change, error) {
	return nil, errNotYetImplemented
}

// ----- helpers -----

func pgIdent(s string) string { return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\"" }

func pgIdents(ss []string) string {
	parts := make([]string, len(ss))
	for i, s := range ss {
		parts[i] = pgIdent(s)
	}
	return strings.Join(parts, ", ")
}

func pgQualify(schema, name string) string {
	if schema == "" {
		return pgIdent(name)
	}
	return pgIdent(schema) + "." + pgIdent(name)
}

func pgLiteral(v string) string {
	if v == "" {
		return "''"
	}
	if (v[0] >= '0' && v[0] <= '9') || v == "true" || v == "false" || strings.HasPrefix(v, "CURRENT_") {
		return v
	}
	return "'" + strings.ReplaceAll(v, "'", "''") + "'"
}
