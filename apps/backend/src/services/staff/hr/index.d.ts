// src/services/staff/hr/index.d.ts
// TypeScript type declarations for HR services

// Dashboard Types
export interface DashboardOverview {
  total_staff: number;
  active_staff: number;
  inactive_staff: number;
  new_hires_30_days: number;
  currently_checked_in: number;
  average_salary: number | null;
  attendance_rate: number;
}

export interface DepartmentStats {
  department: string;
  total_staff: number;
  active_staff: number;
  present_today: number;
  avg_salary: number | null;
  attendance_rate: number;
  staffing_status: 'adequate' | 'understaffed';
}

export interface HRDashboardData {
  overview: DashboardOverview;
  departmentBreakdown: DepartmentStats[];
  attendanceTrends: Array<{
    date: string;
    unique_staff: number;
    avg_hours: number;
  }>;
  performanceMetrics: {
    avg_performance_rating: number;
    high_performers: number;
    low_performers: number;
  } | null;
  upcomingTasks: Array<{
    task_type: string;
    staff_name: string;
    employee_id: string;
    due_date: string;
  }>;
  alerts: {
    low_attendance: number;
    upcoming_reviews: number;
    new_hires_need_onboarding: number;
  };
  lastUpdated: string;
}

// Performance Types
export interface PerformanceReviewData {
  staff_id: number;
  rating: number;
  review_period: string;
  reviewer_comments: string;
  goals_achieved?: string[];
  areas_for_improvement?: string[];
  future_goals?: string[];
  training_recommendations?: string[];
  reviewerId: string;
  reviewerName: string;
}

export interface PerformanceReport {
  reportDetails: {
    department: string;
    timeframe: string;
    dateRange: { start_date: string; end_date: string } | null;
    generatedAt: string;
  };
  staffPerformance: Array<{
    id: number;
    name: string;
    employee_id: string;
    position: string;
    department: string;
    current_rating: number | null;
    average_rating: number | null;
    last_review_date: string | null;
    performance_trend: 'improving' | 'declining' | 'stable' | 'unknown';
  }>;
  departmentSummary: Array<{
    department: string;
    staff_count: number;
    avg_current_rating: number | null;
    avg_review_rating: number | null;
    total_reviews: number;
  }>;
  performanceDistribution: Array<{
    performance_level: string;
    count: number;
  }>;
  insights: {
    totalStaffEvaluated: number;
    averageRating: number;
    highPerformers: number;
    needsAttention: number;
  };
}

// Leave Types
export interface LeaveApplicationData {
  staff_id: number;
  leave_type: string;
  start_date: string;
  end_date: string;
  reason: string;
  emergency_contact?: string;
  appliedBy: string;
}

export interface LeaveBalance {
  staff: {
    name: string;
    employee_id: string;
    hire_date: string;
  };
  year: number;
  leaveBalance: Array<{
    leave_type: string;
    annual_entitlement: number;
    days_used: number;
    days_remaining: number;
  }>;
  leaveHistory: Array<{
    leave_type: string;
    start_date: string;
    end_date: string;
    days_taken: number;
    status: string;
    reason: string;
    approved_by: string | null;
    approved_date: string | null;
  }>;
  summary: {
    total_entitled: number;
    total_used: number;
    total_remaining: number;
  };
}

// Department Types
export interface DepartmentStaffSummary {
  department: string;
  overview: {
    total_staff: number;
    active_staff: number;
    full_time: number;
    part_time: number;
    contract: number;
    attendance_today: number;
    attendance_rate: number;
    avg_hours_today: number;
  };
  salary: {
    average: number | null;
    minimum: number | null;
    maximum: number | null;
  };
  performance: {
    average_rating: number | null;
    high_performers: number;
    needs_improvement: number;
  };
  positionBreakdown: Array<{
    position: string;
    count: number;
    avg_salary: number | null;
  }>;
  shiftBreakdown: Array<{
    shift_type: string;
    count: number;
  }>;
  experienceDistribution: Array<{
    experience_range: string;
    count: number;
  }>;
  staffList: Array<{
    id: number;
    name: string;
    email: string;
    phone: string;
    employee_id: string;
    position: string;
    shift_type: string;
    employment_type: string;
    hire_date: string;
    tenure: number;
    performance_rating: number | null;
    attendance_status: 'present' | 'checked_out' | 'absent';
  }>;
}

// Report Types
export interface StaffReportParams {
  report_type: 'attendance' | 'performance' | 'leave' | 'payroll';
  department?: string;
  start_date?: string;
  end_date?: string;
  format?: 'json' | 'csv';
  generatedBy: string;
}

// Function Declarations
export function getHRDashboardData(timeframe: string): Promise<HRDashboardData>;

export function generatePerformanceReport(queryParams: {
  department?: string;
  timeframe?: string;
  start_date?: string;
  end_date?: string;
  userRole: string;
}): Promise<PerformanceReport>;

export function createPerformanceReview(reviewData: PerformanceReviewData): Promise<{
  review: any;
  staffInfo: { name: string; employee_id: string };
}>;

export function getOnboardingChecklist(staffId: number): Promise<{
  staffInfo: any;
  onboardingProgress: any;
  tasks: any[];
  recommendations: string[];
} | null>;

export function updateOnboardingTask(
  staffId: number,
  taskId: number,
  completed: boolean,
  completedBy: string
): Promise<{ task: any; message: string } | null>;

export function isUserViewingOwnOnboarding(staffId: number, userUid: string): Promise<boolean>;

export function getStaffLeaveBalance(staffId: number, year: number): Promise<LeaveBalance | null>;

export function applyForLeave(leaveData: LeaveApplicationData): Promise<{
  application: any;
  staffInfo: any;
  leaveBalance: any;
}>;

export function isUserApplyingOwnLeave(staffId: number, userUid: string): Promise<boolean>;

export function isUserViewingOwnData(staffId: number, userUid: string): Promise<boolean>;

export function getDepartmentStaffSummary(department: string): Promise<DepartmentStaffSummary>;

export function getAttendanceAnalytics(queryParams: {
  department?: string;
  start_date?: string;
  end_date?: string;
  group_by?: 'day' | 'week' | 'month';
}): Promise<any>;

export function generateStaffReport(reportParams: StaffReportParams): Promise<{
  data?: string;
  report_type?: string;
  department?: string;
  date_range?: any;
  generated_by?: string;
  generated_at?: string;
}>;

// Constants
export * from './constants';