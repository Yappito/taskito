import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAccessibleProjectIds } from "@/server/authz";

/** Root page — redirect to first project or login */
export default async function Home() {
  const session = await auth();
  if (!session) redirect("/login");

  let projectIds: string[];
  try {
    projectIds = await getAccessibleProjectIds(prisma, session.user.id);
  } catch {
    redirect("/login");
  }
  const accessibleProjects = projectIds.length > 0
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        orderBy: { createdAt: "asc" },
        select: {
          slug: true,
          _count: {
            select: {
              tasks: true,
            },
          },
        },
      })
    : [];

  const preferredProject = accessibleProjects.find((project) => project._count.tasks > 0)
    ?? accessibleProjects[0];

  if (preferredProject) {
    redirect(`/${preferredProject.slug}`);
  }

  if (session.user.role === "admin") {
    redirect("/settings");
  }

  redirect("/no-access");
}
