import { describe, expect, it } from "vitest";
import {
  buildSidebarFolderRoots,
  filterSidebarFolderEntries,
  isLikelyAbsoluteFolderPath,
  joinClientPath,
  parentClientPath,
  type SidebarSearchProject,
} from "./SidebarSearchPalette.logic";

describe("SidebarSearchPalette folder picker logic", () => {
  it("builds stable folder roots from home and projects", () => {
    const projects: SidebarSearchProject[] = [
      {
        id: "project-1",
        name: "Acode",
        cwd: "C:\\Users\\Addis\\source\\repos\\Acode",
      },
      {
        id: "project-2",
        name: "Home duplicate",
        cwd: "C:\\Users\\Addis",
      },
    ];

    expect(
      buildSidebarFolderRoots({
        homeDirectory: "C:\\Users\\Addis",
        projects,
      }),
    ).toEqual([
      { id: "home", label: "Home", path: "C:\\Users\\Addis" },
      { id: "source-repos", label: "Repos", path: "C:\\Users\\Addis\\source\\repos" },
      { id: "project:project-1", label: "Acode", path: "C:\\Users\\Addis\\source\\repos\\Acode" },
      { id: "drive-root", label: "Drive", path: "C:\\" },
    ]);
  });

  it("filters visible entries to matching directories", () => {
    expect(
      filterSidebarFolderEntries(
        [
          { path: "Acode", name: "Acode", kind: "directory" },
          { path: "react", name: "react", kind: "directory" },
          { path: "README.md", name: "README.md", kind: "file" },
        ],
        "aco",
      ),
    ).toEqual([{ path: "Acode", name: "Acode", kind: "directory" }]);
  });

  it("does not treat pasted absolute paths as folder filters", () => {
    expect(
      filterSidebarFolderEntries(
        [
          { path: "Acode", name: "Acode", kind: "directory" },
          { path: "react", name: "react", kind: "directory" },
        ],
        "C:\\Users\\Addis\\source\\repos",
      ),
    ).toHaveLength(2);
    expect(isLikelyAbsoluteFolderPath("/Users/Addis/source/repos")).toBe(true);
    expect(isLikelyAbsoluteFolderPath("repos")).toBe(false);
  });

  it("joins and climbs client paths across Windows and POSIX inputs", () => {
    expect(joinClientPath("C:\\Users\\Addis", "source")).toBe("C:\\Users\\Addis\\source");
    expect(parentClientPath("C:\\Users\\Addis\\source")).toBe("C:\\Users\\Addis");
    expect(joinClientPath("/Users/Addis", "source")).toBe("/Users/Addis/source");
    expect(parentClientPath("/Users/Addis/source")).toBe("/Users/Addis");
  });
});
