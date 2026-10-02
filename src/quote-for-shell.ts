/** Quotes a value as one word for the system shell, whatever characters it holds. */
export const quoteForShell = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
