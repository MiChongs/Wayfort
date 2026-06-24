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

// ----- B2: View / Function / Procedure -----

func (d *postgresDesigner) RenderView(ctx context.Context, s ViewSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: ViewSpec.Name required")
	}
	prefix := "CREATE"
	if s.OrReplace {
		prefix = "CREATE OR REPLACE"
	}
	kind := "VIEW"
	if s.Materialized {
		kind = "MATERIALIZED VIEW"
	}
	return fmt.Sprintf("%s %s %s AS %s", prefix, kind, pgQualify(s.Schema, s.Name), s.Definition), nil
}

func (d *postgresDesigner) RenderFunction(ctx context.Context, s FunctionSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: FunctionSpec.Name required")
	}
	lang := s.Language
	if lang == "" {
		lang = "plpgsql"
	}
	return fmt.Sprintf(`CREATE FUNCTION %s(%s) RETURNS %s
LANGUAGE %s
AS $$
%s
$$`, pgQualify(s.Schema, s.Name), pgArgs(s.Args), s.ReturnType, lang, s.Body), nil
}

func (d *postgresDesigner) RenderProcedure(ctx context.Context, s ProcedureSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: ProcedureSpec.Name required")
	}
	lang := s.Language
	if lang == "" {
		lang = "plpgsql"
	}
	return fmt.Sprintf(`CREATE PROCEDURE %s(%s)
LANGUAGE %s
AS $$
BEGIN
  %s;
END
$$`, pgQualify(s.Schema, s.Name), pgArgs(s.Args), lang, s.Body), nil
}

// ----- B3: Trigger / Event / Index / Sequence -----

func (d *postgresDesigner) RenderTrigger(ctx context.Context, s TriggerSpec) (string, error) {
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
	each := s.ForEach
	if each == "" {
		each = "ROW"
	}
	events := strings.Join(s.Events, " OR ")
	if events == "" {
		events = "INSERT"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TRIGGER %s %s %s ON %s\n", pgIdent(s.Name), timing, events, pgQualify(s.Schema, s.Table))
	fmt.Fprintf(&b, "FOR EACH %s\n", each)
	if s.When != "" {
		fmt.Fprintf(&b, "WHEN (%s)\n", s.When)
	}
	fmt.Fprintf(&b, "EXECUTE FUNCTION %s", s.Body)
	return b.String(), nil
}

func (d *postgresDesigner) RenderEvent(ctx context.Context, s EventSpec) (string, error) {
	return "", errors.New("designer: PostgreSQL has no native events; use the pg_cron extension or an external scheduler")
}

func (d *postgresDesigner) RenderIndex(ctx context.Context, s IndexSpec) (string, error) {
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
	fmt.Fprintf(&b, "%s INDEX %s USING %s (%s)", prefix, pgIdent(s.Name), method, pgIdents(s.Columns))
	if s.Where != "" {
		fmt.Fprintf(&b, " WHERE %s", s.Where)
	}
	return b.String(), nil
}

func (d *postgresDesigner) RenderSequence(ctx context.Context, s SequenceSpec) (string, error) {
	if s.Name == "" {
		return "", errors.New("designer: SequenceSpec.Name required")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE SEQUENCE %s", pgQualify(s.Schema, s.Name))
	if s.Start != 0 {
		fmt.Fprintf(&b, " START WITH %d", s.Start)
	}
	if s.Increment != 0 {
		fmt.Fprintf(&b, " INCREMENT BY %d", s.Increment)
	}
	if s.MinValue != nil {
		fmt.Fprintf(&b, " MINVALUE %d", *s.MinValue)
	}
	if s.MaxValue != nil {
		fmt.Fprintf(&b, " MAXVALUE %d", *s.MaxValue)
	}
	if s.Cache > 0 {
		fmt.Fprintf(&b, " CACHE %d", s.Cache)
	}
	if s.Cycle {
		b.WriteString(" CYCLE")
	} else {
		b.WriteString(" NO CYCLE")
	}
	return b.String(), nil
}

// pgArgs renders a function/procedure argument list with optional IN/OUT/INOUT mode.
func pgArgs(args []ArgSpec) string {
	parts := make([]string, len(args))
	for i, a := range args {
		if a.Mode != "" {
			parts[i] = fmt.Sprintf("%s %s %s", a.Mode, a.Name, a.DataType)
		} else {
			parts[i] = fmt.Sprintf("%s %s", a.Name, a.DataType)
		}
	}
	return strings.Join(parts, ", ")
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
