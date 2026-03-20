import * as api from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

// Departments Hooks
export const useDepartments = () => {
  return useQuery({
    queryKey: ["departments"],
    queryFn: api.getDepartments,
  });
};

export const useCreateDepartment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      api.createDepartment(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["departments"] });
      toast.success("Department created successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create department");
    },
  });
};

// Dashboard Hook
export const useDashboardData = () => {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: api.getDashboardData,
    refetchInterval: 30000, // Refetch every 30 seconds
  });
};

// Doctors Hooks
export const useDoctors = () => {
  return useQuery({
    queryKey: ["doctors"],
    queryFn: api.getDoctors,
  });
};

export const useDeleteDoctor = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => api.deleteDoctor(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["doctors"] });
      toast.success("Doctor deleted successfully");
    },
  });
};
