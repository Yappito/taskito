import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** Root page — redirect to first project or login */
export default async function Home() {
  const session = await auth();
  if (!session) redirect("/login");

  const accessibleProjects = session.user.role === "admin"
    ? await prisma.project.findMany({
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
    : await prisma.project.findMany({
        where: {
          members: {
            some: { userId: session.user.id },
          },
        },
        orderBy: { createdAt: "asc" },
        select: {
          slug: true,
          _count: {
            select: {
              tasks: true,
            },
          },
        },
      });

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
