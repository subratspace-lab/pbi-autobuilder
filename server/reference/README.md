# Reference report (optional)

To make generated reports match your exact Power BI Desktop version:

1. In Power BI Desktop create any report (one page, one visual is enough).
2. *File → Save as → Power BI project (.pbip)*.
3. Copy the saved `*.Report` folder into this directory.

The exporter then uses the base theme found in `*.Report/StaticResources/SharedResources/BaseThemes/` instead of its built-in copy.
