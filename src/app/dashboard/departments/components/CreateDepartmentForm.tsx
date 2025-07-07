// src/app/dashboard/departments/components/CreateDepartmentForm.tsx
'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useCreateDepartment } from '@/hooks/api-hooks';
import { useEffect } from 'react';

const DepartmentFormSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional(),
});

type DepartmentFormData = z.infer<typeof DepartmentFormSchema>;

export function CreateDepartmentForm() {
  const createDepartment = useCreateDepartment();
  
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DepartmentFormData>({
    resolver: zodResolver(DepartmentFormSchema),
  });

  const onSubmit = async (data: DepartmentFormData) => {
    await createDepartment.mutateAsync(data);
    reset();
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 p-4 border rounded-lg bg-white">
      <h3 className="text-lg font-semibold">Add New Department</h3>
      
      <div>
        <label htmlFor="name">Department Name</label>
        <input
          {...register('name')}
          type="text"
          className="border p-2 rounded w-full"
        />
        {errors.name && (
          <p className="text-red-600 text-sm mt-1">{errors.name.message}</p>
        )}
      </div>
      
      <div>
        <label htmlFor="description">Description</label>
        <textarea
          {...register('description')}
          className="border p-2 rounded w-full"
          rows={3}
        />
      </div>
      
      <button
        type="submit"
        disabled={createDepartment.isPending}
        className="bg-blue-500 text-white p-2 rounded"
      >
        {createDepartment.isPending ? 'Creating...' : 'Create Department'}
      </button>
    </form>
  );
}