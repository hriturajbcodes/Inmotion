-- ============================================================================
-- Jindal Steel & Power - SMS Digital Transformation & Automation
-- Weighbridge Integration: In-Motion (IMWB) vs Static Matching Views
-- ============================================================================

USE [IMWB_STWB];
GO

-- 1. Combined Static Weighbridge View (BF1 & BF2)
IF OBJECT_ID('dbo.v_static_hm_weight_combined', 'V') IS NOT NULL
    DROP VIEW dbo.v_static_hm_weight_combined;
GO

CREATE VIEW dbo.v_static_hm_weight_combined AS
SELECT 
    'BF1' AS STATIC_SOURCE,
    s.ID AS STATIC_SOURCE_ID,
    LTRIM(RTRIM(s.TAPNO)) AS BFCASTID,
    -- Normalize torpedo ID: clean whitespace, leading zeros, and prefixes
    REPLACE(LTRIM(RTRIM(s.LADLENO)), ' ', '') AS TORPEDO_NO,
    s.SEQNO AS STATIC_SEQNO,
    CAST(s.GROSSWT AS DECIMAL(10, 2)) AS STATIC_GROSS_WT,
    s.TIMESTAMP_GROSSWT AS STATIC_GROSS_TIME,
    CAST(s.TAREWT AS DECIMAL(10, 2)) AS STATIC_TARE_WT,
    s.TIMESTAMP_TAREWT AS STATIC_TARE_TIME,
    CAST(s.NETWT AS DECIMAL(10, 2)) AS STATIC_NET_WT,
    s.TIMESTAMP AS STATIC_RECORD_TIME,
    s.ENDUSER,
    s.DeleteFlag
FROM BF_LAB_INTERFACE.dbo.BF_HM_WEIGHT s
WHERE (s.DeleteFlag = 0 OR s.DeleteFlag IS NULL)

UNION ALL

SELECT 
    'BF2' AS STATIC_SOURCE,
    s.ID AS STATIC_SOURCE_ID,
    LTRIM(RTRIM(s.TAPNO)) AS BFCASTID,
    REPLACE(LTRIM(RTRIM(s.LADLENO)), ' ', '') AS TORPEDO_NO,
    s.SEQNO AS STATIC_SEQNO,
    CAST(s.GROSSWT AS DECIMAL(10, 2)) AS STATIC_GROSS_WT,
    s.TIMESTAMP_GROSSWT AS STATIC_GROSS_TIME,
    CAST(s.TAREWT AS DECIMAL(10, 2)) AS STATIC_TARE_WT,
    s.TIMESTAMP_TAREWT AS STATIC_TARE_TIME,
    CAST(s.NETWT AS DECIMAL(10, 2)) AS STATIC_NET_WT,
    s.TIMESTAMP AS STATIC_RECORD_TIME,
    s.ENDUSER,
    s.DeleteFlag
FROM BF2_LAB.dbo.BF_HM_WEIGHT s
WHERE (s.DeleteFlag = 0 OR s.DeleteFlag IS NULL);
GO

-- 2. Consolidated In-Motion Weighbridge (IMWB) View
IF OBJECT_ID('dbo.v_imwb_consolidated', 'V') IS NOT NULL
    DROP VIEW dbo.v_imwb_consolidated;
GO

CREATE VIEW dbo.v_imwb_consolidated AS
SELECT 
    t.id AS train_id,
    l.id AS load_id,
    o.id AS ocr_id,
    l.torpedo_sequence,
    t.entry_time,
    t.exit_time,
    t.speed,
    LTRIM(RTRIM(t.direction)) AS direction,
    CAST(l.torpedo_dynamic_impact_load AS DECIMAL(10, 2)) AS dynamic_weight,
    REPLACE(LTRIM(RTRIM(o.recognized_number)), ' ', '') AS torpedo_no,
    o.confidence_score
FROM imwb_train t
INNER JOIN imwb_torpedo_load l 
    ON l.train_id = t.id
LEFT JOIN imwb_torpedo_ocr_info o 
    ON o.train_id = t.id 
   AND o.torpedo_sequence = l.torpedo_sequence;
GO

-- 3. Final Matched Dashboard View (dbo.dashboard)
IF OBJECT_ID('dbo.dashboard', 'V') IS NOT NULL
    DROP VIEW dbo.dashboard;
GO

CREATE VIEW dbo.dashboard AS
WITH MatchedPairs AS (
    SELECT 
        st.STATIC_SOURCE,
        st.STATIC_SOURCE_ID,
        st.BFCASTID,
        st.TORPEDO_NO,
        st.STATIC_SEQNO,
        st.STATIC_GROSS_WT,
        st.STATIC_GROSS_TIME,
        st.STATIC_TARE_WT,
        st.STATIC_TARE_TIME,
        st.STATIC_NET_WT,
        st.STATIC_RECORD_TIME,

        -- Matched Gross Candidate: Direction = Towards Steel Metling Point
        g.load_id AS IMWB_GROSS_LOAD_ID,
        g.dynamic_weight AS IMWB_GROSS_WT,
        g.entry_time AS IMWB_GROSS_TIME,
        ABS(DATEDIFF(SECOND, st.STATIC_GROSS_TIME, g.entry_time)) AS GROSS_TIME_DIFF_SECONDS,

        -- Matched Tare Candidate: Direction = Towards Blast Furnace
        tr.load_id AS IMWB_TARE_LOAD_ID,
        tr.dynamic_weight AS IMWB_TARE_WT,
        tr.entry_time AS IMWB_TARE_TIME,
        ABS(DATEDIFF(SECOND, st.STATIC_TARE_TIME, tr.entry_time)) AS TARE_TIME_DIFF_SECONDS

    FROM dbo.v_static_hm_weight_combined st

    -- Gross matching within 120-minute window (+/- 7200 seconds)
    OUTER APPLY (
        SELECT TOP 1 
            im.load_id,
            im.dynamic_weight,
            im.entry_time,
            im.confidence_score
        FROM dbo.v_imwb_consolidated im
        WHERE im.direction LIKE '%Steel Metling Point%'
          AND (
                im.torpedo_no = st.TORPEDO_NO
                OR LTRIM(STR(TRY_CAST(im.torpedo_no AS INT))) = LTRIM(STR(TRY_CAST(st.TORPEDO_NO AS INT)))
              )
          AND st.STATIC_GROSS_TIME IS NOT NULL
          AND ABS(DATEDIFF(SECOND, st.STATIC_GROSS_TIME, im.entry_time)) <= 7200
        ORDER BY 
            ABS(DATEDIFF(SECOND, st.STATIC_GROSS_TIME, im.entry_time)) ASC,
            im.confidence_score DESC,
            im.load_id DESC
    ) g

    -- Tare matching within 120-minute window (+/- 7200 seconds)
    OUTER APPLY (
        SELECT TOP 1 
            im.load_id,
            im.dynamic_weight,
            im.entry_time,
            im.confidence_score
        FROM dbo.v_imwb_consolidated im
        WHERE im.direction LIKE '%Blast Furnace%'
          AND (
                im.torpedo_no = st.TORPEDO_NO
                OR LTRIM(STR(TRY_CAST(im.torpedo_no AS INT))) = LTRIM(STR(TRY_CAST(st.TORPEDO_NO AS INT)))
              )
          AND st.STATIC_TARE_TIME IS NOT NULL
          AND ABS(DATEDIFF(SECOND, st.STATIC_TARE_TIME, im.entry_time)) <= 7200
        ORDER BY 
            ABS(DATEDIFF(SECOND, st.STATIC_TARE_TIME, im.entry_time)) ASC,
            im.confidence_score DESC,
            im.load_id DESC
    ) tr
)
SELECT 
    STATIC_SOURCE,
    STATIC_SOURCE_ID,
    BFCASTID,
    TORPEDO_NO,
    STATIC_SEQNO,
    STATIC_GROSS_WT,
    STATIC_GROSS_TIME,
    STATIC_TARE_WT,
    STATIC_TARE_TIME,
    STATIC_NET_WT,
    STATIC_RECORD_TIME,

    IMWB_GROSS_LOAD_ID,
    IMWB_GROSS_WT,
    IMWB_GROSS_TIME,
    GROSS_TIME_DIFF_SECONDS,

    IMWB_TARE_LOAD_ID,
    IMWB_TARE_WT,
    IMWB_TARE_TIME,
    TARE_TIME_DIFF_SECONDS,

    -- IMWB Net Weight
    CASE 
        WHEN IMWB_GROSS_WT IS NOT NULL AND IMWB_TARE_WT IS NOT NULL 
        THEN CAST(IMWB_GROSS_WT - IMWB_TARE_WT AS DECIMAL(10, 2))
        ELSE NULL 
    END AS IMWB_NET_WT,

    -- Signed Net Delta: Positive means Static is higher; Negative means IMWB is higher
    CASE 
        WHEN STATIC_NET_WT IS NOT NULL AND IMWB_GROSS_WT IS NOT NULL AND IMWB_TARE_WT IS NOT NULL 
        THEN CAST(STATIC_NET_WT - (IMWB_GROSS_WT - IMWB_TARE_WT) AS DECIMAL(10, 2))
        ELSE NULL 
    END AS NET_WT_DIFFERENCE,

    -- Percentage Delta guarded against zero / null
    CASE 
        WHEN STATIC_NET_WT IS NOT NULL AND STATIC_NET_WT <> 0 AND IMWB_GROSS_WT IS NOT NULL AND IMWB_TARE_WT IS NOT NULL 
        THEN CAST(((STATIC_NET_WT - (IMWB_GROSS_WT - IMWB_TARE_WT)) / STATIC_NET_WT) * 100.0 AS DECIMAL(10, 2))
        ELSE NULL 
    END AS NET_WT_DIFFERENCE_PCT,

    -- Exact status semantics
    CASE 
        WHEN IMWB_GROSS_LOAD_ID IS NOT NULL AND IMWB_TARE_LOAD_ID IS NOT NULL THEN 'MATCHED'
        WHEN IMWB_GROSS_LOAD_ID IS NOT NULL AND IMWB_TARE_LOAD_ID IS NULL THEN 'GROSS_ONLY'
        WHEN IMWB_GROSS_LOAD_ID IS NULL AND IMWB_TARE_LOAD_ID IS NOT NULL THEN 'TARE_ONLY'
        ELSE 'PENDING'
    END AS MATCH_STATUS
FROM MatchedPairs;
GO