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

// ----- B2: View / Function / Procedure -----

func (d *mysqlDesigner) RenderView(ctx context.Context, s ViewSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: ViewSpec.Name required")
	}
	if s.Materialized {
		return "", errors.New("designer: MySQL does not support materialized views; use a regular view plus a scheduled refresh")
	}
	prefix := "CREATE"
	if s.OrReplace {
		prefix = "CREATE OR REPLACE"
	}
	return fmt.Sprintf("%s VIEW %s AS %s", prefix, mysqlQualify(s.Schema, s.Name), s.Definition), nil
}

func (d *mysqlDesigner) RenderFunction(ctx context.Context, s FunctionSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: FunctionSpec.Name required")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE FUNCTION %s(%s)\n", mysqlQualify(s.Schema, s.Name), mysqlArgs(s.Args))
	fmt.Fprintf(&b, "RETURNS %s\n", s.ReturnType)
	if s.Language == "" || s.Language == "SQL" {
		b.WriteString("DETERMINISTIC\n")
	}
	b.WriteString("BEGIN\n")
	fmt.Fprintf(&b, "  %s\n", s.Body)
	b.WriteString("END")
	return b.String(), nil
}

func (d *mysqlDesigner) RenderProcedure(ctx context.Context, s ProcedureSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: ProcedureSpec.Name required")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE PROCEDURE %s(%s)\n", mysqlQualify(s.Schema, s.Name), mysqlProcArgs(s.Args))
	b.WriteString("BEGIN\n")
	fmt.Fprintf(&b, "  %s\n", s.Body)
	b.WriteString("END")
	return b.String(), nil
}

// ----- B3: Trigger / Event / Index / Sequence -----

func (d *mysqlDesigner) RenderTrigger(ctx context.Context, s TriggerSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: TriggerSpec.Name required")
	}
	if s.Table == "" {
		return "", errors.New("designer: TriggerSpec.Table required")
	}
	timing := s.Timing
	if timing == "" {
		timing = "BEFORE"
	}
	events := strings.Join(s.Events, " OR ")
	if events == "" {
		events = "INSERT"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TRIGGER %s %s %s ON %s FOR EACH ROW\n", mysqlQualify(s.Schema, s.Name), timing, events, mysqlQualify("", s.Table))
	b.WriteString("BEGIN\n")
	fmt.Fprintf(&b, "  %s\n", s.Body)
	b.WriteString("END")
	return b.String(), nil
}

func (d *mysqlDesigner) RenderEvent(ctx context.Context, s EventSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: EventSpec.Name required")
	}
	if s.Schedule == "" {
		return "", errors.New("designer: EventSpec.Schedule required")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE EVENT %s ON SCHEDULE %s\n", mysqlQualify(s.Schema, s.Name), s.Schedule)
	if s.OnComplete != "" {
		fmt.Fprintf(&b, "ON COMPLETION %s\n", s.OnComplete)
	}
	b.WriteString("DO BEGIN\n")
	fmt.Fprintf(&b, "  %s\n", s.Body)
	b.WriteString("END")
	return b.String(), nil
}

func (d *mysqlDesigner) RenderIndex(ctx context.Context, s IndexSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: IndexSpec.Name required")
	}
	prefix := "CREATE"
	if s.Unique {
		prefix = "CREATE UNIQUE"
	}
	method := s.Method
	if method == "" {
		method = "BTREE"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s INDEX %s USING %s (%s)", prefix, mysqlIdent(s.Name), method, mysqlIdents(s.Columns))
	if s.Where != "" {
		fmt.Fprintf(&b, " WHERE %s", s.Where)
	}
	return b.String(), nil
}

func (d *mysqlDesigner) RenderSequence(ctx context.Context, s SequenceSpec) (string, error) {
	return "", errors.New("designer: MySQL has no SEQUENCE object; use an AUTO_INCREMENT column instead")
}

// mysqlArgs renders a function argument list. MySQL functions only allow IN
// (implicit) parameters, so the mode is omitted.
func mysqlArgs(args []ArgSpec) string {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = fmt.Sprintf("%s %s", mysqlIdent(a.Name), a.DataType)
	}
	return strings.Join(parts, ", ")
}

// mysqlProcArgs renders a procedure argument list with explicit IN/OUT/INOUT mode.
func mysqlProcArgs(args []ArgSpec) string {
	parts := make([]string, len(args))
	for i, a := range args {
		mode := a.Mode
		if mode == "" {
			mode = "IN"
		}
		parts[i] = fmt.Sprintf("%s %s %s", mode, mysqlIdent(a.Name), a.DataType)
	}
	return strings.Join(parts, ", ")
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
