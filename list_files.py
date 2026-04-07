import os

def list_files():
    for root, dirs, files in os.walk("."):
        # Skip common hidden directories
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for file in files:
            path = os.path.join(root, file)
            if not path.startswith("./"):
                path = os.path.join(".", path)
            print(path.replace("\\", "/"))

if __name__ == "__main__":
    list_files()
