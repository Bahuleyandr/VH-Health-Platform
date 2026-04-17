"use client";

import { useState } from "react";
import { Modal } from "./Modal";

export type SignModalType = "hr" | "admin" | "reject";

export function RevisionSignModal({
  open,
  signType,
  onClose,
  onSign,
  onReject,
  isSigning,
  isRejecting,
}: {
  open: boolean;
  signType: SignModalType | null;
  onClose: () => void;
  onSign: (comment: string) => void;
  onReject: (reason: string) => void;
  isSigning: boolean;
  isRejecting: boolean;
}) {
  const [comment, setComment] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  const handleClose = () => {
    setComment("");
    setRejectReason("");
    onClose();
  };

  const title =
    signType === "hr"
      ? "Apply HR Signature"
      : signType === "admin"
      ? "Admin Countersign"
      : "Reject Revision";

  return (
    <Modal open={open} onClose={handleClose} title={title}>
      {signType === "reject" ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Please provide a reason for rejection:</p>
          <textarea
            rows={3}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <button
            onClick={() => onReject(rejectReason)}
            disabled={isRejecting || !rejectReason.trim()}
            className="w-full bg-red-600 text-white py-2 rounded-lg font-semibold hover:bg-red-700 disabled:opacity-50"
          >
            {isRejecting ? "Rejecting..." : "Confirm Rejection"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            {signType === "hr"
              ? "You are applying the first HR countersign. The revision will move to admin approval."
              : "You are applying the final admin countersign. This will approve the revision for application."}
          </p>
          <textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <button
            onClick={() => onSign(comment)}
            disabled={isSigning}
            className="w-full bg-teal-700 text-white py-2 rounded-lg font-semibold hover:bg-teal-800 disabled:opacity-50"
          >
            {isSigning
              ? "Signing..."
              : signType === "hr"
              ? "Apply HR Signature"
              : "Apply Admin Countersign"}
          </button>
        </div>
      )}
    </Modal>
  );
}
