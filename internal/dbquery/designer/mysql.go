package designer

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

type mysqlDesigner struct{}

// NewMySQL returns a Designer that renders MySQL-flavored DDL for all 8
// object kinds. Phase 3B.1 ships Table; the rest return errNotYetImplemented
// — later tasks fill them in.
func NewMySQL() Designer { return &mysqlDesigner{} }

func (d *mysqlDesigner) RenderTable(ctx context.Context, spec TableSpec) (string, error) {
	if spec.Name == "" {
		return "", errors.New("designer: TableSpec.Name required")
	}
	lines := make([]string, 0, len(spec.Columns)+1)
	for _, c := range spec.Columns {
		var lb strings.Builder
		fmt.Fprintf(&lb, "  %s %s", mysqlIdent(c.Name), c.DataType)
		if !c.Nullable {
			lb.WriteString(" NOT NULL")
		}
		if c.AutoIncrement {
			lb.WriteString(" AUTO_INCREMENT")
		}
		if c.Default != nil {
			fmt.Fprintf(&lb, " DEFAULT %s", mysqlLiteral(*c.Default))
		}
		if c.Comment != "" {
			fmt.Fprintf(&lb, " COMMENT '%s'", mysqlEscape(c.Comment))
		}
		lines = append(lines, lb.String())
	}
	if len(spec.PrimaryKey) > 0 {
		lines = append(lines, fmt.Sprintf("  PRIMARY KEY (%s)", mysqlIdents(spec.PrimaryKey)))
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s (\n", mysqlQualify(spec.Schema, spec.Name))
	b.WriteString(strings.Join(lines, ",\n"))
	b.WriteString("\n)")
	if spec.Engine != "" {
		fmt.Fprintf(&b, " ENGINE=%s", spec.Engine)
	}
	if spec.Charset != "" {
		fmt.Fprintf(&b, " DEFAULT CHARSET=%s", spec.Charset)
	}
	if spec.Comment != "" {
		fmt.Fprintf(&b, " COMMENT='%s'", mysqlEscape(spec.Comment))
	}
	return b.String(), nil
}

// Stubs for the other 7 object kinds — filled in by tasks B2/B3.
func (d *mysqlDesigner) RenderView(ctx context.Context, s ViewSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *mysqlDesigner) RenderFunction(ctx context.Context, s FunctionSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *mysqlDesigner) RenderProcedure(ctx context.Context, s ProcedureSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *mysqlDesigner) RenderTrigger(ctx context.Context, s TriggerSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *mysqlDesigner) RenderEvent(ctx context.Context, s EventSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *mysqlDesigner) RenderIndex(ctx context.Context, s IndexSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *mysqlDesigner) RenderSequence(ctx context.Context, s SequenceSpec) (string, error) {
	return "", errNotYetImplemented
}
func (d *mysqlDesigner) Diff(ctx context.Context, oldSpec, newSpec any) ([]Change, error) {
	return nil, errNotYetImplemented
}

// errNotYetImplemented is the shared sentinel returned by every Render*
// method that has not been implemented yet (tasks B2/B3 fill them in).
// Declared once in mysql.go and reused across the dialect files.
var errNotYetImplemented = errors.New("designer: not yet implemented in this task")

// ----- helpers -----

func mysqlIdent(s string) string { return "`" + strings.ReplaceAll(s, "`", "``") + "`" }

func mysqlIdents(ss []string) string {
	parts := make([]string, len(ss))
	for i, s := range ss {
		parts[i] = mysqlIdent(s)
	}
	return strings.Join(parts, ", ")
}

func mysqlQualify(schema, name string) string {
	if schema == "" {
		return mysqlIdent(name)
	}
	return mysqlIdent(schema) + "." + mysqlIdent(name)
}

func mysqlEscape(s string) string { return strings.ReplaceAll(s, "'", "''") }

func mysqlLiteral(v string) string {
	// Numeric / SQL func literal pass-through; otherwise single-quote.
	if v == "" {
		return "''"
	}
	if (v[0] >= '0' && v[0] <= '9') || v == "true" || v == "false" || v == "NULL" {
		return v
	}
	if strings.HasPrefix(v, "CURRENT_") || strings.Contains(v, "()") {
		return v
	}
	return "'" + mysqlEscape(v) + "'"
}
