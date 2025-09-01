#!/bin/bash

# This script concatenates the core Arkade Assets markdown files into a single document.

# Define the output file
OUTPUT_FILE="Arkade-Assets-Documentation.md"

# List of source files in the desired order
SOURCE_FILES=(
    "arkade-assets.md"
    "arkade-script.md"
    "examples.md"
    "ArkadeKitties.md"
)

# Clear the output file if it exists
> "$OUTPUT_FILE"

# Loop through the source files and append them to the output file
for file in "${SOURCE_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "Appending $file..."
        cat "$file" >> "$OUTPUT_FILE"
        # Add a page break (or just newlines) for better separation
        echo -e "\n\n<div style=\"page-break-after: always;\"></div>\n\n" >> "$OUTPUT_FILE"
    else
        echo "Warning: $file not found. Skipping."
    fi
done

echo "Successfully created $OUTPUT_FILE"
