// A repo with no commits yet compares against the empty tree, so every file in it reads as new.
const EMPTY_TREES = { sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321" };

export function mapEmptyTree(format) {
  return Object.hasOwn(EMPTY_TREES, format) ? EMPTY_TREES[format] : null;
}
