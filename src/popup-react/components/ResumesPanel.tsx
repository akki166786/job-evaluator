import { useState, useEffect } from 'react';
import { Home } from 'lucide-react';
import { Button } from './ui/button';
import {
  getAllResumes,
  addResume,
  deleteResume,
  generateResumeId,
} from '@/lib/db';

export function ResumesPanel({
  onBack,
  onResumesChange,
}: {
  onBack: () => void;
  onResumesChange: () => void;
}) {
  const [resumes, setResumes] = useState<{ id: string; label: string }[]>([]);
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ meta: string; text: string } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getAllResumes().then((list) =>
      setResumes(list.map((r) => ({ id: r.id, label: r.label })))
    ).catch(() => setResumes([]));
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setFile(f ?? null);
    setPreview(null);
    setError(null);
  };

  const handleParse = async () => {
    if (!label.trim() || !file) {
      setError(!label.trim() ? 'Enter a label.' : 'Choose a PDF or DOCX file.');
      return;
    }
    const ext = file.name.toLowerCase().slice(-4);
    if (ext !== '.pdf' && file.name.toLowerCase().slice(-5) !== '.docx') {
      setError('Only PDF and DOCX are supported.');
      return;
    }
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const buf = await file.arrayBuffer();
      let text: string;
      if (ext === '.pdf') {
        let workerUrl = '';
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
            workerUrl = chrome.runtime.getURL('pdf.worker.mjs');
          }
        } catch {
          workerUrl = '';
        }
        if (!workerUrl || workerUrl.includes('invalid')) {
          throw new Error(
            'PDF parsing unavailable (extension context invalid). Reopen the panel or use DOCX.'
          );
        }
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
        const pdf = await pdfjsLib.getDocument({ data: buf, useSystemFonts: true }).promise;
        const parts: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map((it: { str?: string }) => it.str ?? '').join(' ');
          parts.push(pageText);
        }
        text = parts.join('\n').replace(/\s+/g, ' ').trim();
      } else {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ arrayBuffer: buf });
        text = result.value.replace(/\s+/g, ' ').trim();
      }
      if (!text || text.length < 50) {
        setError('Could not extract enough text from the file.');
        setLoading(false);
        return;
      }
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      setPreview({
        meta: `"${label}" — ${text.length.toLocaleString()} characters, ~${words.toLocaleString()} words extracted.`,
        text: text.trim().slice(0, 220) + (text.length > 220 ? '…' : ''),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveResume = async () => {
    if (!preview || !label.trim()) return;
    setError(null);
    try {
      const buf = await file!.arrayBuffer();
      let text: string;
      const ext = file!.name.toLowerCase().slice(-4);
      if (ext === '.pdf') {
        const pdfjsLib = await import('pdfjs-dist');
        const workerUrl = chrome.runtime.getURL('pdf.worker.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
        const pdf = await pdfjsLib.getDocument({ data: buf, useSystemFonts: true }).promise;
        const parts: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          parts.push(content.items.map((it: { str?: string }) => it.str ?? '').join(' '));
        }
        text = parts.join('\n').replace(/\s+/g, ' ').trim();
      } else {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ arrayBuffer: buf });
        text = result.value.replace(/\s+/g, ' ').trim();
      }
      await addResume({
        id: generateResumeId(),
        label: label.trim(),
        text,
      });
      setLabel('');
      setFile(null);
      setPreview(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      getAllResumes().then((list) =>
        setResumes(list.map((r) => ({ id: r.id, label: r.label })))
      );
      onResumesChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteResume(id);
      setResumes((prev) => prev.filter((r) => r.id !== id));
      onResumesChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <p className="text-sm text-gray-600">Add up to 5 resumes (PDF or DOCX). Label each (e.g. Frontend, Full-stack).</p>
      <div className="flex flex-wrap items-end gap-2">
        <input
          type="text"
          className="w-32 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          placeholder="Label (e.g. Frontend)"
          maxLength={50}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          type="file"
          className="text-sm"
          accept=".pdf,.docx"
          onChange={handleFileChange}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={handleParse}
          disabled={loading}
        >
          {loading ? 'Parsing…' : 'Parse'}
        </Button>
      </div>
      {loading && <p className="text-sm text-gray-500">Parsing…</p>}
      {preview && (
        <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm">
          <p className="font-medium text-gray-700">{preview.meta}</p>
          <p className="mt-1 text-gray-600">{preview.text}</p>
          <p className="mt-2 text-xs text-gray-500">This text will be sent to the model when you evaluate a job.</p>
          <Button className="mt-2" size="sm" onClick={handleSaveResume}>
            {saved ? 'Saved ✓' : 'Save CV'}
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <p className="text-sm font-medium text-gray-700">Your resumes</p>
      <ul className="space-y-2">
        {resumes.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between rounded border border-gray-200 bg-white px-3 py-2"
          >
            <span className="text-sm font-medium">{r.label}</span>
            <Button variant="ghost" size="sm" onClick={() => handleDelete(r.id)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {resumes.length === 0 && <p className="text-sm text-gray-500">No resumes yet.</p>}
      <Button variant="outline" size="sm" onClick={onBack}>
        <Home className="mr-1 h-4 w-4" />
        Home
      </Button>
    </div>
  );
}
