import { redirect } from "next/navigation";

export default function PatientsPage() {
  redirect("/dashboard/users?role=PATIENT");
}
