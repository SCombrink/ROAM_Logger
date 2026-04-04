import os
import glob

def list_python_scripts():
    # Find all .py files in the current directory
    py_files = glob.glob("*.py")
    
    if not py_files:
        print("No Python scripts found in the current directory.")
    else:
        print("Python scripts in the current directory:")
        for file in py_files:
            print(f"- {file}")

if __name__ == "__main__":
    list_python_scripts()
