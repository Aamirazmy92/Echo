export function neutralizeCsvFormula(value: string): string {
  const firstNonWhitespace = value.match(/^[\s\u0000-\u001f]*([=+\-@])/u)?.[1];
  return firstNonWhitespace ? `'${value}` : value;
}

export function escapeCsvField(value: string): string {
  const normalized = neutralizeCsvFormula(value).replace(/"/g, '""');
  return `"${normalized}"`;
}
