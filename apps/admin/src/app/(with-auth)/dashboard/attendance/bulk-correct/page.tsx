'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import toast from 'react-hot-toast';
import { bulkCorrectAttendance } from '@/lib/api/attendance';
import { CheckCircle2, Download } from 'lucide-react';

interface Correction {
  staff_id: string | number;
  date: string;
  check_in_time?: string;
  check_out_time?: string;
  reason?: string;
}

interface CorrectionResult {
  applied: number;
  skipped: number;
  errors: Array<{ staff_id: string | number; date: string; error: string }>;
}

export default function BulkCorrectionPage() {
  const [csvText, setCsvText] = useState('');
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [globalReason, setGlobalReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CorrectionResult | null>(null);

  const parseCSV = (text: string) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) {
      toast.error('CSV must have a header row and at least one data row');
      return;
    }

    lines[0].split(',').map(h => h.trim()); // validate header exists
    const data: Correction[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      if (values.length < 2 || !values[0]) continue;

      const correction: Correction = {
        staff_id: values[0],
        date: values[1],
        check_in_time: values[2] || undefined,
        check_out_time: values[3] || undefined,
        reason: values[4] || undefined
      };

      data.push(correction);
    }

    if (data.length === 0) {
      toast.error('No valid corrections found in CSV');
      return;
    }

    setCorrections(data);
    toast.success(`Parsed ${data.length} corrections`);
  };

  const handleDownloadTemplate = async () => {
    try {
      const response = await fetch('/api/v1/staff/admin/attendance/bulk-template');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'attendance_bulk_template.csv';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch {
      toast.error('Failed to download template');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        setCsvText(text);
        parseCSV(text);
      };
      reader.readAsText(file);
    }
  };

  const handleSubmit = async () => {
    if (corrections.length === 0) {
      toast.error('Please provide corrections');
      return;
    }

    try {
      setSubmitting(true);
      const response = await bulkCorrectAttendance<{ data: CorrectionResult }>({
        corrections,
        reason: globalReason || undefined
      });
      setResult(response.data);
      toast.success('Bulk correction completed');
    } catch {
      toast.error('Failed to apply corrections');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-primary">Bulk Attendance Correction</h1>
        <p className="text-sm text-gray-600 mt-1">
          Upload or paste CSV data to correct multiple attendance records
        </p>
      </div>

      {!result ? (
        <div className="space-y-6">
          {/* Template Download */}
          <div className="bg-blue-50 rounded-lg p-4 border border-blue-200 flex items-center justify-between">
            <div>
              <p className="font-medium text-blue-900">Need a template?</p>
              <p className="text-sm text-blue-700">Download a CSV template to use as reference</p>
            </div>
            <Button
              onClick={handleDownloadTemplate}
              variant="outline"
              className="gap-2"
            >
              <Download size={16} />
              Download Template
            </Button>
          </div>

          {/* CSV Input */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Upload CSV File</label>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-white hover:file:bg-primary/90"
              />
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-300"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white text-gray-500">Or paste CSV data</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">CSV Data</label>
              <Textarea
                placeholder="staff_id,date,check_in_time,check_out_time,reason&#10;1,2026-03-26,2026-03-26 08:00:00,2026-03-26 17:00:00,Network outage"
                value={csvText}
                onChange={(e) => {
                  setCsvText(e.target.value);
                  if (e.target.value.trim()) {
                    parseCSV(e.target.value);
                  }
                }}
                className="font-mono text-xs min-h-32"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Global Reason (Optional)</label>
              <Input
                placeholder="Reason to apply to all corrections if not specified individually"
                value={globalReason}
                onChange={(e) => setGlobalReason(e.target.value)}
              />
            </div>
          </div>

          {/* Preview */}
          {corrections.length > 0 && (
            <div className="space-y-4">
              <h2 className="font-semibold text-lg">Preview ({corrections.length} records)</h2>
              <div className="overflow-x-auto rounded-lg border max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50 sticky top-0">
                      <th className="px-4 py-2 text-left">Staff ID</th>
                      <th className="px-4 py-2 text-left">Date</th>
                      <th className="px-4 py-2 text-left">Check-in</th>
                      <th className="px-4 py-2 text-left">Check-out</th>
                      <th className="px-4 py-2 text-left">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {corrections.map((c, idx) => (
                      <tr key={idx} className="border-b hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono">{c.staff_id}</td>
                        <td className="px-4 py-2">{c.date}</td>
                        <td className="px-4 py-2 text-xs">{c.check_in_time || '—'}</td>
                        <td className="px-4 py-2 text-xs">{c.check_out_time || '—'}</td>
                        <td className="px-4 py-2 text-xs">{c.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Button
                onClick={handleSubmit}
                disabled={submitting}
                className="w-full bg-primary text-white hover:bg-primary/90"
              >
                {submitting ? 'Applying Corrections...' : 'Apply Corrections'}
              </Button>
            </div>
          )}
        </div>
      ) : (
        /* Result Summary */
        <div className="space-y-4">
          <div className="bg-green-50 rounded-lg p-6 border border-green-200">
            <div className="flex items-center gap-3 mb-4">
              <CheckCircle2 className="text-green-600" size={24} />
              <h2 className="text-xl font-semibold text-green-900">Bulk Correction Completed</h2>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="bg-white rounded p-3">
                <p className="text-sm text-gray-600">Applied</p>
                <p className="text-2xl font-bold text-green-600">{result.applied}</p>
              </div>
              <div className="bg-white rounded p-3">
                <p className="text-sm text-gray-600">Skipped</p>
                <p className="text-2xl font-bold text-yellow-600">{result.skipped}</p>
              </div>
              <div className="bg-white rounded p-3">
                <p className="text-sm text-gray-600">Errors</p>
                <p className="text-2xl font-bold text-red-600">{result.errors?.length || 0}</p>
              </div>
            </div>

            {result.errors && result.errors.length > 0 && (
              <div>
                <p className="font-medium text-gray-900 mb-2">Errors:</p>
                <div className="bg-white rounded p-3 max-h-48 overflow-y-auto">
                  {result.errors.map((err, idx) => (
                    <div key={idx} className="text-xs text-red-600 mb-1 font-mono">
                      Staff {err.staff_id} ({err.date}): {err.error}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Button
            onClick={() => {
              setCsvText('');
              setCorrections([]);
              setResult(null);
              setGlobalReason('');
            }}
            className="w-full"
            variant="outline"
          >
            Start Over
          </Button>
        </div>
      )}
    </div>
  );
}
