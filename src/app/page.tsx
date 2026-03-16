import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** Root page — redirect to first project or login */
export default async function Home() {
  const session = await auth();
  if (!session) redirect("/login");

  const firstProject = session.user.role === "admin"
    ? await prisma.project.findFirst({
        orderBy: { createdAt: "asc" },
        select: { slug: true },
      })
    : await prisma.project.findFirst({
        where: {
          members: {
            some: { userId: session.user.id },
          },
        },
        orderBy: { createdAt: "asc" },
        select: { slug: true },
      });

  if (firstProject) {
    redirect(`/${firstProject.slug}`);
  }

  if (session.user.role === "admin") {
    redirect("/settings");
  }

  redirect("/no-access");
}
