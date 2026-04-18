"use client";

import React, { useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import {
  generateDischargeSummary,
  saveDischargeSummary,
  signDischargeSummary,
} from "@/lib/api";
import toast from "react-hot-toast";

export default function DischargeSummaryPage() {
  const searchParams = useSearchParams();
  const admissionId = Number(searchParams.get("id"));
  const patientName = searchParams.get("name") || "Patient";

  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [signing, setSigning] = useState(false);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [isSigned, setIsSigned] = useState(false);

  // Editable fields
  const [hospitalCourse, setHospitalCourse] = useState("");
  const [dischargeDiagnosis, setDischargeDiagnosis] = useState("");
  const [dischargeCondition, setDischargeCondition] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [activityRestrictions, setActivityRestrictions] = useState("");
  const [dietInstructions, setDietInstructions] = useState("");
  const [warningSigns, setWarningSigns] = useState("");

  const populateFromSummary = useCallback(
    (data: Record<string, unknown>) => {
      setHospitalCourse(String(data.hospital_course || ""));
      setDischargeDiagnosis(String(data.discharge_diagnosis || ""));
      setDischargeCondition(String(data.discharge_condition || ""));
      setFollowUp(String(data.follow_up_instructions || ""));
      setActivityRestrictions(String(data.activity_restrictions || ""));
      setDietInstructions(String(data.diet_instructions || ""));
      setWarningSigns(String(data.warning_signs || ""));
    },
    []
  );

  const handleGenerate = async () => {
    if (!admissionId) return toast.error("No admission ID provided");
    setGenerating(true);
    try {
      const result = await generateDischargeSummary(admissionId);
      const ds =
        (result as Record<string, unknown>)?.discharge_summary as Record<
          string,
          unknown
        >;
      if (ds) {
        setSummary(ds);
        populateFromSummary(ds);
        setIsSigned(false);
        toast.success("Discharge summary generated (draft)");
      }
    } catch (e) {
      toast.error(`Generation failed: ${(e as Error).message}`);
    } finally {
      setGenerating(false);
    }
  };

  const buildEdited = (): Record<string, unknown> => ({
    ...summary,
    hospital_course: hospitalCourse,
    discharge_diagnosis: dischargeDiagnosis,
    discharge_condition: dischargeCondition,
    follow_up_instructions: followUp,
    activity_restrictions: activityRestrictions,
    diet_instructions: dietInstructions,
    warning_signs: warningSigns,
  });

  const handleSave = async () => {
    setLoading(true);
    try {
      await saveDischargeSummary(admissionId, buildEdited());
      toast.success("Draft saved");
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSign = async () => {
    if (
      !confirm(
        "Once signed, this discharge summary becomes the official record and cannot be modified. Only addenda are allowed after signing.\n\nProceed?"
      )
    )
      return;

    await handleSave();
    setSigning(true);
    try {
      await signDischargeSummary(admissionId);
      setIsSigned(true);
      toast.success("Discharge summary signed — now official");
    } catch (e) {
      toast.error(`Sign failed: ${(e as Error).message}`);
    } finally {
      setSigning(false);
    }
  };

  if (!admissionId) {
    return (
      <div className="p-8 text-center text-gray-500">
        No admission ID provided. Navigate here from an admission record.
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Discharge Summary</h1>
          <p className="text-gray-500">{patientName} — Admission #{admissionId}</p>
        </div>
        {summary && !isSigned && (
          <button
            onClick={handleSave}
            disabled={loading}
            className="px-4 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50"
          >
            {loading ? "Saving..." : "Save Draft"}
          </button>
        )}
      </div>

      {!summary ? (
        <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-gray-200 rounded-xl">
          <svg
            className="w-16 h-16 text-blue-400 mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <h2 className="text-lg font-semibold mb-2">
            Generate Discharge Summary
          </h2>
          <p className="text-gray-500 text-center max-w-md mb-6">
            Automatically aggregates ward notes, vitals, investigations,
            medications, and diagnoses into a structured discharge summary.
          </p>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {generating ? (
              <>
                <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                Generating...
              </>
            ) : (
              "Generate Summary"
            )}
          </button>
        </div>
      ) : (
        <>
          {isSigned && (
            <div className="flex items-center gap-2 p-4 mb-6 bg-green-50 border border-green-200 rounded-lg text-green-700">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="font-medium">
                Signed — This summary is official and immutable
              </span>
            </div>
          )}

          <div className="space-y-5">
            <Field
              label="Hospital Course"
              value={hospitalCourse}
              onChange={setHospitalCourse}
              rows={6}
              readOnly={isSigned}
            />
            <Field
              label="Discharge Diagnosis"
              value={dischargeDiagnosis}
              onChange={setDischargeDiagnosis}
              rows={2}
              readOnly={isSigned}
            />
            <Field
              label="Discharge Condition"
              value={dischargeCondition}
              onChange={setDischargeCondition}
              rows={2}
              readOnly={isSigned}
            />
            <Field
              label="Follow-up Instructions"
              value={followUp}
              onChange={setFollowUp}
              rows={3}
              readOnly={isSigned}
            />
            <Field
              label="Activity Restrictions"
              value={activityRestrictions}
              onChange={setActivityRestrictions}
              rows={2}
              readOnly={isSigned}
            />
            <Field
              label="Diet Instructions"
              value={dietInstructions}
              onChange={setDietInstructions}
              rows={2}
              readOnly={isSigned}
            />
            <Field
              label="Warning Signs"
              value={warningSigns}
              onChange={setWarningSigns}
              rows={3}
              readOnly={isSigned}
            />

            {/* Medications */}
            {Array.isArray(summary.medications_on_discharge) &&
              (summary.medications_on_discharge as Array<Record<string, string>>)
                .length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">
                    Medications on Discharge
                  </h3>
                  <div className="grid gap-2">
                    {(
                      summary.medications_on_discharge as Array<
                        Record<string, string>
                      >
                    ).map((med, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg"
                      >
                        <span className="text-blue-500">💊</span>
                        <div>
                          <p className="font-medium">{med.name}</p>
                          <p className="text-sm text-gray-500">
                            {med.dose} {med.route} {med.frequency}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            {/* Investigations */}
            {Array.isArray(summary.investigations_summary) &&
              (summary.investigations_summary as Array<Record<string, string>>)
                .length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">
                    Investigations
                  </h3>
                  <div className="grid gap-2">
                    {(
                      summary.investigations_summary as Array<
                        Record<string, string>
                      >
                    ).map((inv, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg"
                      >
                        <span className="text-purple-500">🔬</span>
                        <div>
                          <p className="font-medium">{inv.test}</p>
                          <p className="text-sm text-gray-500">
                            {inv.status} — {inv.result}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>

          {/* Action bar */}
          <div className="flex gap-3 mt-8 pt-6 border-t">
            {!isSigned && (
              <>
                <button
                  onClick={handleGenerate}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Regenerate
                </button>
                <button
                  onClick={handleSign}
                  disabled={signing}
                  className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {signing ? "Signing..." : "Sign Summary"}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  rows = 3,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  readOnly?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        readOnly={readOnly}
        className={`w-full px-3 py-2 border rounded-lg text-sm ${
          readOnly
            ? "bg-gray-50 text-gray-600 cursor-not-allowed"
            : "bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        } border-gray-300`}
      />
    </div>
  );
}
