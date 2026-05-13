function fuzzyMatch(query, text) {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const matchQuery = (normalizedQuery) => {
    if (normalizedQuery.length === 0) {
      return { matches: true, score: 0 };
    }
    if (normalizedQuery.length > textLower.length) {
      return { matches: false, score: 0 };
    }
    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;
    for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
      if (textLower[i] === normalizedQuery[queryIndex]) {
        const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);
        if (lastMatchIndex === i - 1) {
          consecutiveMatches++;
          score -= consecutiveMatches * 5;
        } else {
          consecutiveMatches = 0;
          if (lastMatchIndex >= 0) {
            score += (i - lastMatchIndex - 1) * 2;
          }
        }
        if (isWordBoundary) {
          score -= 10;
        }
        score += i * 0.1;
        lastMatchIndex = i;
        queryIndex++;
      }
    }
    if (queryIndex < normalizedQuery.length) {
      return { matches: false, score: 0 };
    }
    return { matches: true, score };
  };
  const primaryMatch = matchQuery(queryLower);
  if (primaryMatch.matches) {
    return primaryMatch;
  }
  const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumericMatch ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}` : numericAlphaMatch ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}` : "";
  if (!swappedQuery) {
    return primaryMatch;
  }
  const swappedMatch = matchQuery(swappedQuery);
  if (!swappedMatch.matches) {
    return primaryMatch;
  }
  return { matches: true, score: swappedMatch.score + 5 };
}
function fuzzyFilter(items, query, getText) {
  if (!query.trim()) {
    return items;
  }
  const tokens = query.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return items;
  }
  const results = [];
  for (const item of items) {
    const text = getText(item);
    let totalScore = 0;
    let allMatch = true;
    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (match.matches) {
        totalScore += match.score;
      } else {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      results.push({ item, totalScore });
    }
  }
  results.sort((a, b) => a.totalScore - b.totalScore);
  return results.map((r) => r.item);
}
export {
  fuzzyFilter,
  fuzzyMatch
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9mdXp6eS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBGdXp6eSBtYXRjaGluZyB1dGlsaXRpZXMuXG4gKiBNYXRjaGVzIGlmIGFsbCBxdWVyeSBjaGFyYWN0ZXJzIGFwcGVhciBpbiBvcmRlciAobm90IG5lY2Vzc2FyaWx5IGNvbnNlY3V0aXZlKS5cbiAqIExvd2VyIHNjb3JlID0gYmV0dGVyIG1hdGNoLlxuICovXG5cbmV4cG9ydCBpbnRlcmZhY2UgRnV6enlNYXRjaCB7XG5cdG1hdGNoZXM6IGJvb2xlYW47XG5cdHNjb3JlOiBudW1iZXI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmdXp6eU1hdGNoKHF1ZXJ5OiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IEZ1enp5TWF0Y2gge1xuXHRjb25zdCBxdWVyeUxvd2VyID0gcXVlcnkudG9Mb3dlckNhc2UoKTtcblx0Y29uc3QgdGV4dExvd2VyID0gdGV4dC50b0xvd2VyQ2FzZSgpO1xuXG5cdGNvbnN0IG1hdGNoUXVlcnkgPSAobm9ybWFsaXplZFF1ZXJ5OiBzdHJpbmcpOiBGdXp6eU1hdGNoID0+IHtcblx0XHRpZiAobm9ybWFsaXplZFF1ZXJ5Lmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0cmV0dXJuIHsgbWF0Y2hlczogdHJ1ZSwgc2NvcmU6IDAgfTtcblx0XHR9XG5cblx0XHRpZiAobm9ybWFsaXplZFF1ZXJ5Lmxlbmd0aCA+IHRleHRMb3dlci5sZW5ndGgpIHtcblx0XHRcdHJldHVybiB7IG1hdGNoZXM6IGZhbHNlLCBzY29yZTogMCB9O1xuXHRcdH1cblxuXHRcdGxldCBxdWVyeUluZGV4ID0gMDtcblx0XHRsZXQgc2NvcmUgPSAwO1xuXHRcdGxldCBsYXN0TWF0Y2hJbmRleCA9IC0xO1xuXHRcdGxldCBjb25zZWN1dGl2ZU1hdGNoZXMgPSAwO1xuXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCB0ZXh0TG93ZXIubGVuZ3RoICYmIHF1ZXJ5SW5kZXggPCBub3JtYWxpemVkUXVlcnkubGVuZ3RoOyBpKyspIHtcblx0XHRcdGlmICh0ZXh0TG93ZXJbaV0gPT09IG5vcm1hbGl6ZWRRdWVyeVtxdWVyeUluZGV4XSkge1xuXHRcdFx0XHRjb25zdCBpc1dvcmRCb3VuZGFyeSA9IGkgPT09IDAgfHwgL1tcXHNcXC1fLi86XS8udGVzdCh0ZXh0TG93ZXJbaSAtIDFdISk7XG5cblx0XHRcdFx0Ly8gUmV3YXJkIGNvbnNlY3V0aXZlIG1hdGNoZXNcblx0XHRcdFx0aWYgKGxhc3RNYXRjaEluZGV4ID09PSBpIC0gMSkge1xuXHRcdFx0XHRcdGNvbnNlY3V0aXZlTWF0Y2hlcysrO1xuXHRcdFx0XHRcdHNjb3JlIC09IGNvbnNlY3V0aXZlTWF0Y2hlcyAqIDU7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Y29uc2VjdXRpdmVNYXRjaGVzID0gMDtcblx0XHRcdFx0XHQvLyBQZW5hbGl6ZSBnYXBzXG5cdFx0XHRcdFx0aWYgKGxhc3RNYXRjaEluZGV4ID49IDApIHtcblx0XHRcdFx0XHRcdHNjb3JlICs9IChpIC0gbGFzdE1hdGNoSW5kZXggLSAxKSAqIDI7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gUmV3YXJkIHdvcmQgYm91bmRhcnkgbWF0Y2hlc1xuXHRcdFx0XHRpZiAoaXNXb3JkQm91bmRhcnkpIHtcblx0XHRcdFx0XHRzY29yZSAtPSAxMDtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFNsaWdodCBwZW5hbHR5IGZvciBsYXRlciBtYXRjaGVzXG5cdFx0XHRcdHNjb3JlICs9IGkgKiAwLjE7XG5cblx0XHRcdFx0bGFzdE1hdGNoSW5kZXggPSBpO1xuXHRcdFx0XHRxdWVyeUluZGV4Kys7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0aWYgKHF1ZXJ5SW5kZXggPCBub3JtYWxpemVkUXVlcnkubGVuZ3RoKSB7XG5cdFx0XHRyZXR1cm4geyBtYXRjaGVzOiBmYWxzZSwgc2NvcmU6IDAgfTtcblx0XHR9XG5cblx0XHRyZXR1cm4geyBtYXRjaGVzOiB0cnVlLCBzY29yZSB9O1xuXHR9O1xuXG5cdGNvbnN0IHByaW1hcnlNYXRjaCA9IG1hdGNoUXVlcnkocXVlcnlMb3dlcik7XG5cdGlmIChwcmltYXJ5TWF0Y2gubWF0Y2hlcykge1xuXHRcdHJldHVybiBwcmltYXJ5TWF0Y2g7XG5cdH1cblxuXHRjb25zdCBhbHBoYU51bWVyaWNNYXRjaCA9IHF1ZXJ5TG93ZXIubWF0Y2goL14oPzxsZXR0ZXJzPlthLXpdKykoPzxkaWdpdHM+WzAtOV0rKSQvKTtcblx0Y29uc3QgbnVtZXJpY0FscGhhTWF0Y2ggPSBxdWVyeUxvd2VyLm1hdGNoKC9eKD88ZGlnaXRzPlswLTldKykoPzxsZXR0ZXJzPlthLXpdKykkLyk7XG5cdGNvbnN0IHN3YXBwZWRRdWVyeSA9IGFscGhhTnVtZXJpY01hdGNoXG5cdFx0PyBgJHthbHBoYU51bWVyaWNNYXRjaC5ncm91cHM/LmRpZ2l0cyA/PyBcIlwifSR7YWxwaGFOdW1lcmljTWF0Y2guZ3JvdXBzPy5sZXR0ZXJzID8/IFwiXCJ9YFxuXHRcdDogbnVtZXJpY0FscGhhTWF0Y2hcblx0XHRcdD8gYCR7bnVtZXJpY0FscGhhTWF0Y2guZ3JvdXBzPy5sZXR0ZXJzID8/IFwiXCJ9JHtudW1lcmljQWxwaGFNYXRjaC5ncm91cHM/LmRpZ2l0cyA/PyBcIlwifWBcblx0XHRcdDogXCJcIjtcblxuXHRpZiAoIXN3YXBwZWRRdWVyeSkge1xuXHRcdHJldHVybiBwcmltYXJ5TWF0Y2g7XG5cdH1cblxuXHRjb25zdCBzd2FwcGVkTWF0Y2ggPSBtYXRjaFF1ZXJ5KHN3YXBwZWRRdWVyeSk7XG5cdGlmICghc3dhcHBlZE1hdGNoLm1hdGNoZXMpIHtcblx0XHRyZXR1cm4gcHJpbWFyeU1hdGNoO1xuXHR9XG5cblx0cmV0dXJuIHsgbWF0Y2hlczogdHJ1ZSwgc2NvcmU6IHN3YXBwZWRNYXRjaC5zY29yZSArIDUgfTtcbn1cblxuLyoqXG4gKiBGaWx0ZXIgYW5kIHNvcnQgaXRlbXMgYnkgZnV6enkgbWF0Y2ggcXVhbGl0eSAoYmVzdCBtYXRjaGVzIGZpcnN0KS5cbiAqIFN1cHBvcnRzIHNwYWNlLXNlcGFyYXRlZCB0b2tlbnM6IGFsbCB0b2tlbnMgbXVzdCBtYXRjaC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZ1enp5RmlsdGVyPFQ+KGl0ZW1zOiBUW10sIHF1ZXJ5OiBzdHJpbmcsIGdldFRleHQ6IChpdGVtOiBUKSA9PiBzdHJpbmcpOiBUW10ge1xuXHRpZiAoIXF1ZXJ5LnRyaW0oKSkge1xuXHRcdHJldHVybiBpdGVtcztcblx0fVxuXG5cdGNvbnN0IHRva2VucyA9IHF1ZXJ5XG5cdFx0LnRyaW0oKVxuXHRcdC5zcGxpdCgvXFxzKy8pXG5cdFx0LmZpbHRlcigodCkgPT4gdC5sZW5ndGggPiAwKTtcblxuXHRpZiAodG9rZW5zLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBpdGVtcztcblx0fVxuXG5cdGNvbnN0IHJlc3VsdHM6IHsgaXRlbTogVDsgdG90YWxTY29yZTogbnVtYmVyIH1bXSA9IFtdO1xuXG5cdGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuXHRcdGNvbnN0IHRleHQgPSBnZXRUZXh0KGl0ZW0pO1xuXHRcdGxldCB0b3RhbFNjb3JlID0gMDtcblx0XHRsZXQgYWxsTWF0Y2ggPSB0cnVlO1xuXG5cdFx0Zm9yIChjb25zdCB0b2tlbiBvZiB0b2tlbnMpIHtcblx0XHRcdGNvbnN0IG1hdGNoID0gZnV6enlNYXRjaCh0b2tlbiwgdGV4dCk7XG5cdFx0XHRpZiAobWF0Y2gubWF0Y2hlcykge1xuXHRcdFx0XHR0b3RhbFNjb3JlICs9IG1hdGNoLnNjb3JlO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0YWxsTWF0Y2ggPSBmYWxzZTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0aWYgKGFsbE1hdGNoKSB7XG5cdFx0XHRyZXN1bHRzLnB1c2goeyBpdGVtLCB0b3RhbFNjb3JlIH0pO1xuXHRcdH1cblx0fVxuXG5cdHJlc3VsdHMuc29ydCgoYSwgYikgPT4gYS50b3RhbFNjb3JlIC0gYi50b3RhbFNjb3JlKTtcblx0cmV0dXJuIHJlc3VsdHMubWFwKChyKSA9PiByLml0ZW0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBV08sU0FBUyxXQUFXLE9BQWUsTUFBMEI7QUFDbkUsUUFBTSxhQUFhLE1BQU0sWUFBWTtBQUNyQyxRQUFNLFlBQVksS0FBSyxZQUFZO0FBRW5DLFFBQU0sYUFBYSxDQUFDLG9CQUF3QztBQUMzRCxRQUFJLGdCQUFnQixXQUFXLEdBQUc7QUFDakMsYUFBTyxFQUFFLFNBQVMsTUFBTSxPQUFPLEVBQUU7QUFBQSxJQUNsQztBQUVBLFFBQUksZ0JBQWdCLFNBQVMsVUFBVSxRQUFRO0FBQzlDLGFBQU8sRUFBRSxTQUFTLE9BQU8sT0FBTyxFQUFFO0FBQUEsSUFDbkM7QUFFQSxRQUFJLGFBQWE7QUFDakIsUUFBSSxRQUFRO0FBQ1osUUFBSSxpQkFBaUI7QUFDckIsUUFBSSxxQkFBcUI7QUFFekIsYUFBUyxJQUFJLEdBQUcsSUFBSSxVQUFVLFVBQVUsYUFBYSxnQkFBZ0IsUUFBUSxLQUFLO0FBQ2pGLFVBQUksVUFBVSxDQUFDLE1BQU0sZ0JBQWdCLFVBQVUsR0FBRztBQUNqRCxjQUFNLGlCQUFpQixNQUFNLEtBQUssYUFBYSxLQUFLLFVBQVUsSUFBSSxDQUFDLENBQUU7QUFHckUsWUFBSSxtQkFBbUIsSUFBSSxHQUFHO0FBQzdCO0FBQ0EsbUJBQVMscUJBQXFCO0FBQUEsUUFDL0IsT0FBTztBQUNOLCtCQUFxQjtBQUVyQixjQUFJLGtCQUFrQixHQUFHO0FBQ3hCLHNCQUFVLElBQUksaUJBQWlCLEtBQUs7QUFBQSxVQUNyQztBQUFBLFFBQ0Q7QUFHQSxZQUFJLGdCQUFnQjtBQUNuQixtQkFBUztBQUFBLFFBQ1Y7QUFHQSxpQkFBUyxJQUFJO0FBRWIseUJBQWlCO0FBQ2pCO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFFQSxRQUFJLGFBQWEsZ0JBQWdCLFFBQVE7QUFDeEMsYUFBTyxFQUFFLFNBQVMsT0FBTyxPQUFPLEVBQUU7QUFBQSxJQUNuQztBQUVBLFdBQU8sRUFBRSxTQUFTLE1BQU0sTUFBTTtBQUFBLEVBQy9CO0FBRUEsUUFBTSxlQUFlLFdBQVcsVUFBVTtBQUMxQyxNQUFJLGFBQWEsU0FBUztBQUN6QixXQUFPO0FBQUEsRUFDUjtBQUVBLFFBQU0sb0JBQW9CLFdBQVcsTUFBTSx1Q0FBdUM7QUFDbEYsUUFBTSxvQkFBb0IsV0FBVyxNQUFNLHVDQUF1QztBQUNsRixRQUFNLGVBQWUsb0JBQ2xCLEdBQUcsa0JBQWtCLFFBQVEsVUFBVSxFQUFFLEdBQUcsa0JBQWtCLFFBQVEsV0FBVyxFQUFFLEtBQ25GLG9CQUNDLEdBQUcsa0JBQWtCLFFBQVEsV0FBVyxFQUFFLEdBQUcsa0JBQWtCLFFBQVEsVUFBVSxFQUFFLEtBQ25GO0FBRUosTUFBSSxDQUFDLGNBQWM7QUFDbEIsV0FBTztBQUFBLEVBQ1I7QUFFQSxRQUFNLGVBQWUsV0FBVyxZQUFZO0FBQzVDLE1BQUksQ0FBQyxhQUFhLFNBQVM7QUFDMUIsV0FBTztBQUFBLEVBQ1I7QUFFQSxTQUFPLEVBQUUsU0FBUyxNQUFNLE9BQU8sYUFBYSxRQUFRLEVBQUU7QUFDdkQ7QUFNTyxTQUFTLFlBQWUsT0FBWSxPQUFlLFNBQW1DO0FBQzVGLE1BQUksQ0FBQyxNQUFNLEtBQUssR0FBRztBQUNsQixXQUFPO0FBQUEsRUFDUjtBQUVBLFFBQU0sU0FBUyxNQUNiLEtBQUssRUFDTCxNQUFNLEtBQUssRUFDWCxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQztBQUU1QixNQUFJLE9BQU8sV0FBVyxHQUFHO0FBQ3hCLFdBQU87QUFBQSxFQUNSO0FBRUEsUUFBTSxVQUE2QyxDQUFDO0FBRXBELGFBQVcsUUFBUSxPQUFPO0FBQ3pCLFVBQU0sT0FBTyxRQUFRLElBQUk7QUFDekIsUUFBSSxhQUFhO0FBQ2pCLFFBQUksV0FBVztBQUVmLGVBQVcsU0FBUyxRQUFRO0FBQzNCLFlBQU0sUUFBUSxXQUFXLE9BQU8sSUFBSTtBQUNwQyxVQUFJLE1BQU0sU0FBUztBQUNsQixzQkFBYyxNQUFNO0FBQUEsTUFDckIsT0FBTztBQUNOLG1CQUFXO0FBQ1g7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUVBLFFBQUksVUFBVTtBQUNiLGNBQVEsS0FBSyxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQUEsSUFDbEM7QUFBQSxFQUNEO0FBRUEsVUFBUSxLQUFLLENBQUMsR0FBRyxNQUFNLEVBQUUsYUFBYSxFQUFFLFVBQVU7QUFDbEQsU0FBTyxRQUFRLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSTtBQUNqQzsiLAogICJuYW1lcyI6IFtdCn0K
