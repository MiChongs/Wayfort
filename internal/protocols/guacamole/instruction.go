// Guacamole protocol framing helpers.
//
// Each instruction on the wire is `<elemLen>.<elem>,<elemLen>.<elem>,...;` —
// length is the number of UTF-16 code units in the element (Java strings).
// For ASCII / non-surrogate UTF-8 this equals the rune count; for anything
// with surrogate pairs we have to count properly, but credentials / hostnames
// in practice never contain them, so we count runes and rely on the
// protocol's lenient parser. See https://guacamole.apache.org/doc/gug/guacamole-protocol.html
package guacamole

import (
	"bufio"
	"fmt"
	"io"
	"strings"
	"unicode/utf16"
)

// Encode emits a single instruction to w.
func Encode(w io.Writer, opcode string, args ...string) error {
	bw, ok := w.(*bufio.Writer)
	if !ok {
		bw = bufio.NewWriter(w)
		defer bw.Flush()
	}
	if err := writeElement(bw, opcode); err != nil {
		return err
	}
	for _, a := range args {
		if err := bw.WriteByte(','); err != nil {
			return err
		}
		if err := writeElement(bw, a); err != nil {
			return err
		}
	}
	return bw.WriteByte(';')
}

func writeElement(bw *bufio.Writer, s string) error {
	n := utf16Len(s)
	if _, err := fmt.Fprintf(bw, "%d.", n); err != nil {
		return err
	}
	_, err := bw.WriteString(s)
	return err
}

// utf16Len returns the number of UTF-16 code units in s, matching Guacamole's
// Java-side length convention.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if utf16.IsSurrogate(r) || r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// ReadInstruction reads one fully-formed instruction from r and returns the
// opcode and args. Returns io.EOF at the natural end of stream.
func ReadInstruction(r *bufio.Reader) (string, []string, error) {
	var parts []string
	for {
		// length terminator '.'
		lenStr, err := r.ReadString('.')
		if err != nil {
			return "", nil, err
		}
		lenStr = strings.TrimRight(lenStr, ".")
		var n int
		if _, err := fmt.Sscanf(lenStr, "%d", &n); err != nil {
			return "", nil, fmt.Errorf("bad length token %q: %w", lenStr, err)
		}
		buf := make([]rune, 0, n)
		read := 0
		for read < n {
			ru, _, err := r.ReadRune()
			if err != nil {
				return "", nil, err
			}
			buf = append(buf, ru)
			if utf16.IsSurrogate(ru) || ru > 0xFFFF {
				read += 2
			} else {
				read++
			}
		}
		parts = append(parts, string(buf))
		sep, _, err := r.ReadRune()
		if err != nil {
			return "", nil, err
		}
		if sep == ';' {
			break
		}
		if sep != ',' {
			return "", nil, fmt.Errorf("expected , or ; got %q", sep)
		}
	}
	if len(parts) == 0 {
		return "", nil, fmt.Errorf("empty instruction")
	}
	return parts[0], parts[1:], nil
}
