package knowledge

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strings"

	"github.com/ledongthuc/pdf"
	"golang.org/x/net/html"
)

// Rich-format extractors. Each turns one binary/markup format into plain text
// for the chunker. They are dispatched from Extract by extension/MIME before
// the plain-text path runs, mirroring LangChain's documentloaders split.

// extractPDF pulls the embedded text layer out of a PDF. Image-only (scanned)
// PDFs have no text layer and are rejected with a clear error. The underlying
// parser is known to panic on malformed files, so the whole walk is recovered.
func extractPDF(data []byte) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			text, err = "", fmt.Errorf("pdf 解析失败(文件可能损坏): %v", r)
		}
	}()
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("pdf: %w", err)
	}
	plain, err := r.GetPlainText()
	if err != nil {
		return "", fmt.Errorf("pdf text: %w", err)
	}
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, plain); err != nil {
		return "", fmt.Errorf("pdf read: %w", err)
	}
	out := normalizeWhitespace(buf.String())
	if out == "" {
		return "", fmt.Errorf("pdf 不含可提取文本(可能是扫描件/纯图片)")
	}
	return out, nil
}

// extractDOCX reads word/document.xml from the OOXML zip and walks the runs:
// <w:t> carries text, <w:p> ends a paragraph, <w:tab>/<w:br> are whitespace.
// Pure stdlib — no external dependency.
func extractDOCX(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("docx: %w", err)
	}
	var docXML io.ReadCloser
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			if docXML, err = f.Open(); err != nil {
				return "", fmt.Errorf("docx: %w", err)
			}
			break
		}
	}
	if docXML == nil {
		return "", fmt.Errorf("docx: 缺少 word/document.xml(不是有效的 .docx)")
	}
	defer docXML.Close()

	dec := xml.NewDecoder(io.LimitReader(docXML, 64<<20))
	var sb strings.Builder
	depthInT := 0
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("docx xml: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "t":
				depthInT++
			case "tab":
				sb.WriteByte('\t')
			case "br", "cr":
				sb.WriteByte('\n')
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				if depthInT > 0 {
					depthInT--
				}
			case "p":
				sb.WriteByte('\n')
			}
		case xml.CharData:
			if depthInT > 0 {
				sb.Write(t)
			}
		}
	}
	out := normalizeWhitespace(sb.String())
	if out == "" {
		return "", fmt.Errorf("docx 不含可提取文本")
	}
	return out, nil
}

// extractHTML strips tags and returns readable text: script/style/head subtrees
// are skipped, block-level elements become line breaks.
func extractHTML(data []byte) (string, error) {
	doc, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("html: %w", err)
	}
	skip := map[string]bool{
		"script": true, "style": true, "noscript": true, "template": true,
		"head": true, "svg": true, "iframe": true,
	}
	block := map[string]bool{
		"p": true, "div": true, "section": true, "article": true, "li": true,
		"tr": true, "br": true, "ul": true, "ol": true, "table": true,
		"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
		"blockquote": true, "pre": true, "header": true, "footer": true, "main": true,
	}
	var sb strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && skip[n.Data] {
			return
		}
		if n.Type == html.TextNode {
			if t := strings.TrimSpace(n.Data); t != "" {
				sb.WriteString(t)
				sb.WriteByte(' ')
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type == html.ElementNode && block[n.Data] {
			sb.WriteByte('\n')
		}
	}
	walk(doc)
	out := normalizeWhitespace(sb.String())
	if out == "" {
		return "", fmt.Errorf("html 不含可提取文本")
	}
	return out, nil
}

// normalizeWhitespace trims trailing space per line and collapses runs of blank
// lines so extractor output chunks cleanly.
func normalizeWhitespace(s string) string {
	lines := strings.Split(s, "\n")
	var out []string
	blanks := 0
	for _, ln := range lines {
		ln = strings.TrimRight(ln, " \t\r")
		if strings.TrimSpace(ln) == "" {
			blanks++
			if blanks > 1 {
				continue
			}
			out = append(out, "")
			continue
		}
		blanks = 0
		out = append(out, ln)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}
