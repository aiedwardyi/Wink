// Markdown, split into blocks.
//
// The desktop renders bot replies with react-markdown + GFM. The phone was
// showing the source: `**bold**`, `- ` bullets and `[text](url)` arriving as
// literal characters, which is worse than no markdown at all — it is the
// author's intent visible but not applied.
//
// Foundation can already do the *inline* half. `AttributedString(markdown:)`
// handles emphasis, code spans, strikethrough and links, and SwiftUI renders
// the links tappable for free. What it will not do is lay out blocks: with
// `.full` it records a presentation intent and leaves you to draw the bullet,
// the indent and the spacing yourself. So this splits the text into blocks
// and the view draws each one, handing the inline run back to Foundation.
//
// Deliberately not a full CommonMark implementation. It covers what a model
// actually emits into a chat bubble — paragraphs, lists, headings, fences,
// quotes, rules — and treats anything it does not recognise as text, which is
// the failure mode that loses nothing.
import Foundation

public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    /// `indent` is nesting depth, 0 for a top-level item.
    case bullet(indent: Int, text: String)
    case ordered(indent: Int, number: Int, text: String)
    case heading(level: Int, text: String)
    /// A fenced block. `language` is whatever followed the opening fence.
    case code(language: String?, text: String)
    case quote(String)
    case rule
}

public enum Markdown {
    /// Split into blocks. Never throws and never drops input: an unparseable
    /// line ends up in a paragraph, which is what the reader wanted anyway.
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            // GFM: a single newline inside a paragraph is a soft break, which
            // renders as a space. The desktop does not enable `breaks`, so
            // neither does this — the two should wrap the same way.
            blocks.append(.paragraph(paragraph.joined(separator: " ")))
            paragraph.removeAll()
        }

        // Normalise the line endings before splitting, because
        // `CharacterSet.newlines` contains \r and \n *separately* and
        // `components(separatedBy:)` breaks on each of them: "a\r\nb" comes
        // back as ["a", "", "b"], one phantom empty line per CRLF. That empty
        // line is not cosmetic — it calls `flushParagraph`, so a paragraph
        // written across several lines arrives as one paragraph per line, and
        // a fenced block gains a blank line between every line of code. Tool
        // output and pasted text reach chat bubbles with CRLF intact, so this
        // is a path real messages take.
        let normalised = unwrapUserTags(source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n"))
        var lines = normalised.components(separatedBy: "\n")[...]
        while let line = lines.first {
            lines = lines.dropFirst()
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // A fence runs to its closing fence, or to the end — a reply still
            // streaming has an open one, and showing it as code beats showing
            // three backticks and waiting.
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let marker = String(trimmed.prefix(3))
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                while let next = lines.first {
                    lines = lines.dropFirst()
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix(marker) { break }
                    body.append(next)
                }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                continue
            }

            // --- or *** or ___, three or more, nothing else on the line
            if trimmed.count >= 3, "-*_".contains(trimmed.first!),
               trimmed.allSatisfy({ $0 == trimmed.first! }) {
                flushParagraph()
                blocks.append(.rule)
                continue
            }

            if let heading = heading(trimmed) {
                flushParagraph()
                blocks.append(heading)
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                blocks.append(.quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)))
                continue
            }

            if let item = listItem(line) {
                flushParagraph()
                blocks.append(item)
                continue
            }

            paragraph.append(trimmed)
        }
        flushParagraph()
        return blocks
    }

    /// Drops `<userN>` tags a bot left outside a peer reply, keeping the inner text and any code.
    static func unwrapUserTags(_ text: String) -> String {
        guard text.contains("<user") || text.contains("</user") else { return text }
        let tag = try! NSRegularExpression(pattern: "</?user[0-9]+>")
        var fence = ""
        var fenceDepth = 0
        var fenceColumn = 0
        var listColumn = 0
        var wrapped = ""
        var span = 0
        var indented = false
        var blank = true

        func strip(_ part: Substring) -> String {
            let part = String(part)
            return tag.stringByReplacingMatches(in: part, range: NSRange(part.startIndex..., in: part), withTemplate: "")
        }
        let headTags = try! NSRegularExpression(pattern: "^( *)(?:</?user[0-9]+>)+")
        let tailTags = try! NSRegularExpression(pattern: "(?:</?user[0-9]+>)+(\\s*)$")
        let item = try! NSRegularExpression(pattern: "^( *)([-*+]|[0-9]{1,9}[.)])( +)(?=\\S)")
        let openerTag = try! NSRegularExpression(pattern: "^ *<user([0-9]+)>")
        let closerTag = try! NSRegularExpression(pattern: "</user([0-9]+)>(\\s*)$")
        func leadingTags(_ part: String) -> String {
            headTags.stringByReplacingMatches(in: part, range: NSRange(part.startIndex..., in: part), withTemplate: "$1")
        }
        func trimTags(_ part: String) -> String {
            let head = leadingTags(part)
            return tailTags.stringByReplacingMatches(in: head, range: NSRange(head.startIndex..., in: head), withTemplate: "$1")
        }
        func capture(_ regex: NSRegularExpression, _ part: String) -> (id: String, start: String.Index, rest: String)? {
            guard let match = regex.firstMatch(in: part, range: NSRange(part.startIndex..., in: part)),
                  let id = Range(match.range(at: 1), in: part), let all = Range(match.range, in: part) else { return nil }
            let rest = match.numberOfRanges > 2 ? Range(match.range(at: 2), in: part).map { String(part[$0]) } ?? "" : ""
            return (String(part[id]), all.lowerBound, rest)
        }
        // only the opening wrapper's own closer may come off a closing fence line
        func closing(_ part: String) -> String {
            guard !wrapped.isEmpty, let end = capture(closerTag, part), end.id == wrapped else { return part }
            return String(part[..<end.start]) + end.rest
        }
        func listItem(_ part: String) -> (width: Int, spaces: Int)? {
            guard let match = item.firstMatch(in: part, range: NSRange(part.startIndex..., in: part)) else { return nil }
            return (match.range(at: 1).length + match.range(at: 2).length, match.range(at: 3).length)
        }
        func breaks(_ line: String) -> Bool {
            let text = line.drop(while: { $0 == " " })
            guard line.count - text.count <= 3, let first = text.first else { return false }
            if first == "#" {
                let hashes = text.prefix(while: { $0 == "#" }).count
                return hashes <= 6 && (text.count == hashes || text.dropFirst(hashes).first == " " || text.dropFirst(hashes).first == "\t")
            }
            guard first == "-" || first == "*" || first == "_" else { return false }
            let marks = text.filter { $0 != " " && $0 != "\t" }
            return marks.count >= 3 && marks.allSatisfy { $0 == first }
        }
        func isBlank(_ part: Substring) -> Bool { part.allSatisfy { $0 == " " || $0 == "\t" } }
        func unquoted(_ line: String) -> Substring {
            var rest = Substring(line)
            while true {
                let spaces = rest.prefix(while: { $0 == " " }).count
                guard spaces <= 3, rest.dropFirst(spaces).first == ">" else { return rest }
                rest = rest.dropFirst(spaces + 1)
                if let next = rest.first, next == " " || next == "\t" { rest = rest.dropFirst() }
            }
        }
        // `column` is where a list item's content starts, so the fence ends when a line dedents past it
        func fenceStart(_ body: Substring) -> (column: Int, mark: String, after: Substring)? {
            var rest = body
            var column = 0
            var listed = false
            while true {
                let spaces = rest.prefix(while: { $0 == " " }).count
                rest = rest.dropFirst(spaces)
                column += spaces
                if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
                    rest = rest.dropFirst()
                    column += 1
                    listed = true
                    continue
                }
                let digits = rest.prefix(while: { $0.isASCII && $0.isNumber }).count
                if (1...9).contains(digits), let dot = rest.dropFirst(digits).first, dot == "." || dot == ")",
                   rest.dropFirst(digits + 1).first == " " {
                    rest = rest.dropFirst(digits + 1)
                    column += digits + 1
                    listed = true
                    continue
                }
                break
            }
            guard let first = rest.first, first == "`" || first == "~" else { return nil }
            let run = rest.prefix(while: { $0 == first }).count
            let after = rest.dropFirst(run)
            guard run >= 3, first == "~" || !after.contains("`") else { return nil }
            return (listed ? column : 0, String(repeating: first, count: run), after)
        }
        func openTick(_ part: Substring) -> String.Index? {
            var slashes = 0
            var index = part.startIndex
            while index < part.endIndex {
                let char = part[index]
                if char == "`" && slashes % 2 == 0 { return index }
                slashes = char == "\\" ? slashes + 1 : 0
                index = part.index(after: index)
            }
            return nil
        }
        func scan(_ line: String) -> String {
            var out = ""
            var rest = Substring(line)
            while !rest.isEmpty {
                if span == 0 {
                    guard let tick = openTick(rest) else { out += strip(rest); break }
                    out += strip(rest[..<tick])
                    span = rest[tick...].prefix(while: { $0 == "`" }).count
                    let after = rest.index(tick, offsetBy: span)
                    out += rest[tick..<after]
                    rest = rest[after...]
                } else {
                    var cursor = rest.startIndex
                    var close: String.Index?
                    while let next = rest[cursor...].firstIndex(of: "`") {
                        let run = rest[next...].prefix(while: { $0 == "`" }).count
                        cursor = rest.index(next, offsetBy: run)
                        if run == span { close = cursor; break }
                    }
                    guard let end = close else { out += rest; break }
                    out += rest[..<end]
                    span = 0
                    rest = rest[end...]
                }
            }
            return out
        }

        return text.components(separatedBy: "\n").map { line -> String in
            let body = unquoted(line)
            let quote = String(line.prefix(line.count - body.count))
            let depth = quote.filter { $0 == ">" }.count
            // a wrapper around a fenced reply is not part of the fence line
            let trimmed = trimTags(String(body))
            let lead = trimmed.prefix(while: { $0 == " " || $0 == "\t" })
            let core = lead.reduce(into: "") { $0 += $1 == "\t" ? "    " : " " } + trimmed.dropFirst(lead.count)
            let open = fenceStart(Substring(core))
            let indent = core.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
            if !fence.isEmpty && (depth < fenceDepth || (fenceColumn > 0 && !isBlank(Substring(core)) && indent < fenceColumn)) { fence = "" }
            if !fence.isEmpty {
                // only a wrapper that opened with the fence may come off its closing line
                let last = closing(String(body))
                if let open = fenceStart(Substring(last)), depth == fenceDepth, indent <= fenceColumn + 3, open.column == 0, open.mark.first == fence.first,
                   open.mark.count >= fence.count, isBlank(open.after) {
                    fence = ""
                    blank = true
                    return quote + last
                }
                return line
            }
            // a fence marker inside indented code is code, not a fence
            let buried = !isBlank(body) && indent - listColumn >= 4 && (blank || indented)
            if !buried && (open != nil || isBlank(body)) {
                fence = open?.mark ?? ""
                wrapped = open == nil ? "" : capture(openerTag, String(body))?.id ?? ""
                fenceColumn = open.map { $0.column > 0 ? $0.column : (indent >= listColumn ? listColumn : 0) } ?? 0
                fenceDepth = depth
                span = 0
                indented = false
                blank = open == nil
                return open == nil ? line : quote + leadingTags(String(body))
            }
            var code = buried
            if !code, !breaks(core), let item = listItem(core) {
                code = item.spaces >= 5
                listColumn = item.width + (code ? 1 : item.spaces)
            } else if !code && indent < listColumn {
                listColumn = 0
            }
            indented = code
            // indented code may follow a heading or rule without a blank line
            blank = !code && breaks(core)
            return code ? line : scan(line)
        }.joined(separator: "\n")
    }

    private static func heading(_ trimmed: String) -> MarkdownBlock? {
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard hashes >= 1, hashes <= 6 else { return nil }
        let rest = String(trimmed.dropFirst(hashes))
        // "#hashtag" is not a heading; ATX requires the space
        guard rest.hasPrefix(" ") else { return nil }
        return .heading(level: hashes, text: rest.trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ line: String) -> MarkdownBlock? {
        let leading = line.prefix(while: { $0 == " " || $0 == "\t" }).count
        // two spaces per level, which is what a model emits and what GFM
        // treats as nesting for a tight list
        let indent = min(leading / 2, 4)
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            return .bullet(indent: indent, text: String(trimmed.dropFirst(2)))
        }

        // "1. " / "12) "
        let digits = trimmed.prefix(while: \.isNumber)
        if !digits.isEmpty, digits.count <= 9 {
            let rest = trimmed.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
                return .ordered(indent: indent, number: Int(digits) ?? 1, text: String(rest.dropFirst(2)))
            }
        }
        return nil
    }
}
