import Editor, { type OnMount } from '@monaco-editor/react';

interface Props {
  value: string;
  language: 'dax' | 'powerquery' | 'json' | 'markdown';
  onChange?: (v: string) => void;
  height?: number | string;
  readOnly?: boolean;
}

let registered = false;

// Minimal syntax highlighting for DAX and Power Query M.
const onMount: OnMount = (_editor, monaco) => {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: 'dax' });
  monaco.languages.setMonarchTokensProvider('dax', {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/--.*$/, 'comment'],
        [/"([^"]|"")*"/, 'string'],
        [/'([^']|'')*'/, 'type'],
        [/\[[^\]]*\]/, 'variable'],
        [/\b(VAR|RETURN|IN|TRUE|FALSE|NOT|AND|OR)\b/, 'keyword'],
        [/\b[A-Z][A-Z0-9.]*(?=\s*\()/, 'keyword'],
        [/\d+(\.\d+)?/, 'number'],
      ],
    },
  });
  monaco.languages.register({ id: 'powerquery' });
  monaco.languages.setMonarchTokensProvider('powerquery', {
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/#"([^"]|"")*"/, 'variable'],
        [/"([^"]|"")*"/, 'string'],
        [/\b(let|in|each|if|then|else|try|otherwise|and|or|not|type|null|true|false|meta)\b/, 'keyword'],
        [/\b[A-Z][A-Za-z]*\.[A-Za-z.]+/, 'type'],
        [/\d+(\.\d+)?/, 'number'],
      ],
    },
  });
};

export function CodeEditor({ value, language, onChange, height = 220, readOnly }: Props) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <Editor
        height={height}
        language={language}
        value={value}
        onMount={onMount}
        onChange={(v) => onChange?.(v ?? '')}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: 'JetBrains Mono, Consolas, monospace',
          lineNumbers: language === 'powerquery' ? 'on' : 'off',
          scrollBeyondLastLine: false,
          wordWrap: language === 'powerquery' ? 'off' : 'on',
          renderLineHighlight: 'none',
          padding: { top: 8, bottom: 8 },
          automaticLayout: true,
        }}
      />
    </div>
  );
}
