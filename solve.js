// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
// Same answers as the reference on every input, but bulk-scanned:
// unquoted fields on a clean line are taken with one indexOf(',')
// against a cached line end (a line break is found once per record,
// not once per field); quoted fields are taken chunk-by-chunk between
// quotes; only lines holding a stray CR take the slow regex scan.
// No state is kept between calls.

function countNL(s) {
  let c = 0;
  let i = -1;
  while ((i = s.indexOf('\n', i + 1)) !== -1) c++;
  return c;
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Cached end of the line containing the current scan position:
  // index of its '\n', or n when there is none. -1 means not computed.
  // A stray CR is found per field instead: the field's own chunk is
  // short, so checking it beats scanning ahead for the next CR, which
  // on LF-only text can run far past the line.
  let lineEnd = -1;

  function ensureLine(p) {
    if (lineEnd !== -1 && p <= lineEnd) return;
    lineEnd = text.indexOf('\n', p);
    if (lineEnd === -1) lineEnd = n;
  }

  // Slow scan for a line holding a stray CR: one native regex scan
  // finds the next delimiter (comma, LF or CR).
  const delimRe = /[,\n\r]/g;
  function scanUnquotedSlow(p, value, recordLine, recordRow) {
    let out = value;
    let added = 0;
    for (;;) {
      delimRe.lastIndex = p;
      const m = delimRe.exec(text);
      if (m === null) {
        if (p < n) { added += n - p; out += text.slice(p); }
        pos = n;
        lineEnd = -1;
        return { value: out, ended: 2, added };
      }
      const next = m.index;
      const kind = m[0].charCodeAt(0); // 44 comma, 10 LF, 13 CR
      if (kind === 44) {
        if (next > p) { added += next - p; out += text.slice(p, next); }
        pos = next + 1;
        return { value: out, ended: 0, added };
      }
      if (kind === 10) {
        if (next > p) { added += next - p; out += text.slice(p, next); }
        pos = next + 1;
        line += 1;
        lineEnd = -1;
        return { value: out, ended: 1, added };
      }
      if (text.charCodeAt(next + 1) === 10) {
        if (next > p) { added += next - p; out += text.slice(p, next); }
        pos = next + 2;
        line += 1;
        lineEnd = -1;
        return { value: out, ended: 1, added };
      }
      if (next > p) { added += next - p; out += text.slice(p, next); }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      p = next + 1;
    }
  }

  // Scan one unquoted field starting at p, with `value` already built.
  // Returns {value, ended, added}: ended 0=comma, 1=line break, 2=end.
  function scanUnquoted(p, value, recordLine, recordRow) {
    ensureLine(p);
    const comma = text.indexOf(',', p);
    if (comma !== -1 && comma < lineEnd) {
      if (comma > p) {
        const chunk = text.slice(p, comma);
        // Any CR in this chunk is stray (a CRLF can only end the line).
        if (chunk.indexOf('\r') !== -1) return scanUnquotedSlow(p, value, recordLine, recordRow);
        pos = comma + 1;
        return { value: value + chunk, ended: 0, added: comma - p };
      }
      pos = comma + 1;
      return { value, ended: 0, added: 0 };
    }
    // Field ends at the line break, or at the end of the text.
    if (lineEnd >= n) {
      if (p < n) {
        const chunk = text.slice(p);
        if (chunk.indexOf('\r') !== -1) return scanUnquotedSlow(p, value, recordLine, recordRow);
        pos = n;
        return { value: value + chunk, ended: 2, added: n - p };
      }
      pos = n;
      return { value, ended: 2, added: 0 };
    }
    const endPos = lineEnd > p && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    if (endPos > p) {
      const chunk = text.slice(p, endPos);
      if (chunk.indexOf('\r') !== -1) return scanUnquotedSlow(p, value, recordLine, recordRow);
      pos = lineEnd + 1;
      line += 1;
      lineEnd = -1;
      return { value: value + chunk, ended: 1, added: endPos - p };
    }
    pos = lineEnd + 1;
    line += 1;
    lineEnd = -1;
    return { value, ended: 1, added: 0 };
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; lineEnd = -1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; lineEnd = -1; }
      else break;
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = 2;
    let lastQuoted = false;

    do {
      const quoted = text.charCodeAt(pos) === 34;
      lastQuoted = quoted;
      let value;
      if (!quoted) {
        const r = scanUnquoted(pos, '', recordLine, recordRow);
        value = r.value;
        ended = r.ended;
      } else {
        // Quoted field, opening quote at pos. A quoted field can span
        // lines, so the cached line end is no longer valid afterwards.
        lineEnd = -1;
        const open = pos;
        const openLine = line;
        let p = pos + 1;
        let out = '';
        let closed = false;
        let closePos = -1;
        while (true) {
          const q = text.indexOf('"', p);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            // Doubled quote: one literal quote.
            let chunk = text.slice(p, q);
            if (chunk.indexOf('\r') !== -1) chunk = chunk.replace(/\r\n?/g, '\n');
            line += countNL(chunk);
            out += chunk;
            out += '"';
            p = q + 2;
            continue;
          }
          let chunk = text.slice(p, q);
          if (chunk.indexOf('\r') !== -1) chunk = chunk.replace(/\r\n?/g, '\n');
          line += countNL(chunk);
          out += chunk;
          closed = true;
          closePos = q;
          break;
        }
        if (!closed) {
          // Never closes: the quote is literal, text after it is
          // read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = scanUnquoted(pos, '"', recordLine, recordRow);
          value = r.value;
          ended = r.ended;
        } else {
          value = out;
          pos = closePos + 1;
          if (pos >= n) {
            ended = 2;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) { pos += 1; ended = 0; }
            else if (c === 10) { pos += 1; line += 1; ended = 1; }
            else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; ended = 1; }
            else {
              // Junk after the closing quote, appended as it stands.
              const r = scanUnquoted(pos, value, recordLine, recordRow);
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              value = r.value;
              ended = r.ended;
            }
          }
        }
      }
      fields.push(value);
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
