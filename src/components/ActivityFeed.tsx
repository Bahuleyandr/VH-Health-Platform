// src/components/ActivityFeed.tsx
export function ActivityFeed() {
  const { data: activities } = useQuery({
    queryKey: ['activities'],
    queryFn: api.getRecentActivities,
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-semibold mb-4">Recent Activity</h3>
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {activities?.map((activity) => (
          <div key={activity.id} className="flex items-start gap-3">
            <div className="w-2 h-2 bg-blue-500 rounded-full mt-1.5" />
            <div className="flex-1">
              <p className="text-sm">{activity.description}</p>
              <p className="text-xs text-gray-500">
                {formatRelativeTime(activity.timestamp)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}