package knowledge

import "strings"

// TokenCounter returns the token count of a string for the embedding model. It is
// injected (rather than imported from internal/ai/runner) to avoid an import
// cycle — the runner imports this package for the memory service.
type TokenCounter func(text string) int

// Chunk splits text into token-bounded slices with overlap, preferring paragraph
// then sentence then word boundaries so a chunk rarely cuts mid-thought. count
// estimates tokens; chunkTokens/overlap are the target size and carry-over. A nil
// count or non-positive chunkTokens degrades to a ~4-char-per-token heuristic /
// sensible defaults.
func Chunk(text string, chunkTokens, overlap int, count TokenCounter) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	if count == nil {
		count = func(s string) int { return len(s)/4 + 1 }
	}
	if chunkTokens <= 0 {
		chunkTokens = 512
	}
	if overlap < 0 || overlap >= chunkTokens {
		overlap = chunkTokens / 8
	}

	segments := segmentize(text, chunkTokens, count)

	var (
		chunks  []string
		cur     strings.Builder
		curTok  int
	)
	flush := func() {
		s := strings.TrimSpace(cur.String())
		if s != "" {
			chunks = append(chunks, s)
		}
		cur.Reset()
		curTok = 0
	}
	for _, seg := range segments {
		st := count(seg)
		if curTok > 0 && curTok+st > chunkTokens {
			prev := cur.String()
			flush()
			// Seed the next chunk with the tail of the previous one for overlap.
			if overlap > 0 {
				tail := tailByTokens(prev, overlap, count)
				if tail != "" {
					cur.WriteString(tail)
					cur.WriteString("\n")
					curTok = count(tail)
				}
			}
		}
		if cur.Len() > 0 {
			cur.WriteString("\n")
		}
		cur.WriteString(seg)
		curTok += st
	}
	flush()
	return chunks
}

// segmentize breaks text into units no larger than chunkTokens: paragraphs first,
// then over-long paragraphs by sentence, then over-long sentences by word.
func segmentize(text string, chunkTokens int, count TokenCounter) []string {
	var out []string
	for _, para := range strings.Split(text, "\n\n") {
		para = strings.TrimSpace(para)
		if para == "" {
			continue
		}
		if count(para) <= chunkTokens {
			out = append(out, para)
			continue
		}
		for _, sent := range splitSentences(para) {
			if count(sent) <= chunkTokens {
				out = append(out, sent)
				continue
			}
			out = append(out, splitWords(sent, chunkTokens, count)...)
		}
	}
	return out
}

func splitSentences(s string) []string {
	var out []string
	var cur strings.Builder
	for _, r := range s {
		cur.WriteRune(r)
		switch r {
		case '.', '!', '?', '。', '！', '？', '\n':
			if t := strings.TrimSpace(cur.String()); t != "" {
				out = append(out, t)
			}
			cur.Reset()
		}
	}
	if t := strings.TrimSpace(cur.String()); t != "" {
		out = append(out, t)
	}
	return out
}

func splitWords(s string, chunkTokens int, count TokenCounter) []string {
	words := strings.Fields(s)
	var out []string
	var cur strings.Builder
	for _, w := range words {
		probe := cur.String()
		if probe != "" {
			probe += " "
		}
		probe += w
		if cur.Len() > 0 && count(probe) > chunkTokens {
			out = append(out, cur.String())
			cur.Reset()
		}
		if cur.Len() > 0 {
			cur.WriteString(" ")
		}
		cur.WriteString(w)
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// tailByTokens returns the trailing substring of s that is approximately `tokens`
// tokens long, snapped to a word boundary.
func tailByTokens(s string, tokens int, count TokenCounter) string {
	words := strings.Fields(s)
	var tail []string
	for i := len(words) - 1; i >= 0; i-- {
		tail = append([]string{words[i]}, tail...)
		if count(strings.Join(tail, " ")) >= tokens {
			break
		}
	}
	return strings.Join(tail, " ")
}
