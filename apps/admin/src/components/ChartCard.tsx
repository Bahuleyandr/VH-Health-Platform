import dynamic from "next/dynamic";
const ResponsiveContainer = dynamic(
  () => import("recharts").then((m) => m.ResponsiveContainer),
  { ssr: false },
);
const AreaChart = dynamic(() => import("recharts").then((m) => m.AreaChart), {
  ssr: false,
});
const Area = dynamic(() => import("recharts").then((m) => m.Area), {
  ssr: false,
});
const XAxis = dynamic(() => import("recharts").then((m) => m.XAxis), {
  ssr: false,
});
const YAxis = dynamic(() => import("recharts").then((m) => m.YAxis), {
  ssr: false,
});
const Tooltip = dynamic(() => import("recharts").then((m) => m.Tooltip), {
  ssr: false,
});

export function ChartCard({
  title,
  data,
}: {
  title: string;
  data: { date: string; value: number }[];
}) {
  return (
    <div className="bg-card rounded-lg border shadow-sm p-4">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="h-56 mt-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <XAxis dataKey="date" hide />
            <YAxis hide />
            <Tooltip />
            <Area
              type="monotone"
              dataKey="value"
              fill="var(--chart-1)"
              stroke="var(--chart-1)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
