package knowledge

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Extract turns raw uploaded bytes into plain text for chunking. Rich formats
// (PDF / DOCX / HTML — see extract_rich.go) are dispatched by extension/MIME
// first; everything else takes the UTF-8 text path (plain / markdown / json /
// log / csv / source code). Remaining binary formats (xlsx, legacy .doc,
// images, …) are rejected with a clear error so the caller can mark the
// document failed rather than indexing garbage.
func Extract(filename, mime string, data []byte) (string, error) {
	if len(data) == 0 {
		return "", fmt.Errorf("empty document")
	}
	lower := strings.ToLower(filename)
	m := strings.ToLower(mime)
	switch {
	case strings.HasSuffix(lower, ".pdf") || strings.Contains(m, "application/pdf"):
		return extractPDF(data)
	case strings.HasSuffix(lower, ".docx") || strings.Contains(m, "officedocument.wordprocessingml"):
		return extractDOCX(data)
	case strings.HasSuffix(lower, ".html") || strings.HasSuffix(lower, ".htm") || strings.Contains(m, "text/html"):
		return extractHTML(data)
	}
	if isProbablyBinary(filename, mime, data) {
		return "", fmt.Errorf("unsupported binary document (%s): supported formats are UTF-8 text / PDF / DOCX / HTML", displayType(filename, mime))
	}
	if !utf8.Valid(data) {
		return "", fmt.Errorf("document is not valid UTF-8 text")
	}
	return strings.TrimSpace(string(data)), nil
}

func displayType(filename, mime string) string {
	if mime != "" {
		return mime
	}
	if i := strings.LastIndexByte(filename, '.'); i >= 0 {
		return filename[i:]
	}
	return "unknown"
}

// isProbablyBinary rejects known binary types by MIME / extension, and falls back
// to a NUL-byte sniff for unlabeled content.
func isProbablyBinary(filename, mime string, data []byte) bool {
	m := strings.ToLower(mime)
	switch {
	case strings.HasPrefix(m, "text/"),
		strings.Contains(m, "json"), strings.Contains(m, "markdown"),
		strings.Contains(m, "xml"), strings.Contains(m, "yaml"),
		strings.Contains(m, "csv"), strings.Contains(m, "javascript"):
		return false
	}
	lower := strings.ToLower(filename)
	// .pdf / .docx are handled by the rich extractors before this check runs.
	for _, ext := range []string{".doc", ".xlsx", ".xls", ".pptx", ".ppt",
		".png", ".jpg", ".jpeg", ".gif", ".zip", ".gz", ".tar", ".bin", ".exe", ".so", ".dll"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	// Sniff: a NUL byte in the first 8KB is a strong binary signal.
	n := len(data)
	if n > 8192 {
		n = 8192
	}
	for _, b := range data[:n] {
		if b == 0 {
			return true
		}
	}
	return false
}
