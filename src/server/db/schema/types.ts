export interface OtpSendAttempt {
  attempt_no: 1 | 2;
  attempted_at: string;
  api_outcome: "pending" | "api_accepted" | "failed" | "unknown";
  http_status: number | null;
  provider_sent: boolean | null;
  provider_message_id: string | null;
  provider_status: string | null;
  status_at: string | null;
  error_code: string | null;
  error_reason: string | null;
}

export type WorkDays = Record<"sat" | "sun" | "mon" | "tue" | "wed" | "thu" | "fri",
  | { enabled: true; start: string; end: string }
  | { enabled: false; start: null; end: null }
>;

// Explicit operational default from DBMS v2.2 §5, not seed/business data.
export const defaultWorkDays: WorkDays = {
  sat: { enabled: true, start: "08:00", end: "20:00" },
  sun: { enabled: true, start: "08:00", end: "20:00" },
  mon: { enabled: true, start: "08:00", end: "20:00" },
  tue: { enabled: true, start: "08:00", end: "20:00" },
  wed: { enabled: true, start: "08:00", end: "20:00" },
  thu: { enabled: true, start: "08:00", end: "20:00" },
  fri: { enabled: false, start: null, end: null },
};